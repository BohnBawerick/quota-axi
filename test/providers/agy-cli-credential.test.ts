import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agyCliTokenFilePath,
  createAgyCliCredentialBroker,
} from "../../src/providers/agy-cli-credential.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function tokenFile(contents: unknown): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-agy-cli-"));
  const file = join(tempDir, "antigravity-oauth-token");
  writeFileSync(
    file,
    typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
    { mode: 0o600 },
  );
  return file;
}

function brokerFor(file: string, now = Date.now()) {
  return createAgyCliCredentialBroker({
    environment: { QUOTA_AXI_AGY_CLI_TOKEN_FILE: file },
    now: () => now,
  });
}

function validToken(expiry: string): Record<string, unknown> {
  return {
    token: {
      access_token: "agy-access-token",
      token_type: "Bearer",
      refresh_token: "agy-refresh-token",
      expiry,
    },
    auth_method: "consumer",
  };
}

describe("agyCliTokenFilePath", () => {
  it("defaults to the agy CLI's own store under HOME", () => {
    expect(
      agyCliTokenFilePath({ HOME: "/home/someone" }, () => "/unused"),
    ).toBe("/home/someone/.gemini/antigravity-cli/antigravity-oauth-token");
  });

  it("honours an explicit override", () => {
    expect(
      agyCliTokenFilePath(
        { QUOTA_AXI_AGY_CLI_TOKEN_FILE: "/tmp/token.json", HOME: "/home/x" },
        () => "/unused",
      ),
    ).toBe("/tmp/token.json");
  });
});

describe("createAgyCliCredentialBroker", () => {
  it("reads an unexpired token as available", () => {
    const file = tokenFile(validToken("2035-01-01T00:00:00Z"));

    expect(brokerFor(file).resolve()).toEqual({
      status: "available",
      credential: "agy-access-token",
      refreshable: true,
    });
  });

  it("parses the RFC 3339 offset form the agy CLI actually writes", () => {
    const file = tokenFile(validToken("2026-08-23T21:27:31.130943499+08:00"));
    const justBefore = Date.parse("2026-08-23T13:27:31.000Z");

    expect(brokerFor(file, justBefore).resolve()).toMatchObject({
      status: "available",
    });
    expect(brokerFor(file, justBefore + 2000).resolve()).toMatchObject({
      status: "expired",
    });
  });

  it("still returns the credential when stored expiry has passed", () => {
    const file = tokenFile(validToken("2020-01-01T00:00:00Z"));

    // Stored expiry orders candidates; the quota call is the real probe.
    expect(brokerFor(file).resolve()).toEqual({
      status: "expired",
      credential: "agy-access-token",
      refreshable: true,
    });
  });

  it("reports refreshable false when no refresh token is stored", () => {
    const file = tokenFile({
      token: {
        access_token: "agy-access-token",
        expiry: "2035-01-01T00:00:00Z",
      },
    });

    expect(brokerFor(file).resolve()).toMatchObject({ refreshable: false });
  });

  it("treats an absent file as missing, not an error", () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-agy-cli-"));

    expect(brokerFor(join(tempDir, "absent")).resolve()).toEqual({
      status: "missing",
    });
  });

  it.each([
    ["unparseable JSON", "{ not json", "error"],
    ["a non-object root", JSON.stringify([1, 2]), "invalid"],
    ["no token object", JSON.stringify({ auth_method: "consumer" }), "invalid"],
    [
      "an unusable access token",
      JSON.stringify({ token: { access_token: "" } }),
      "invalid",
    ],
    [
      "an unparseable expiry",
      JSON.stringify({ token: { access_token: "a", expiry: "whenever" } }),
      "invalid",
    ],
  ])("reports %s as %s", (_label, contents, status) => {
    expect(brokerFor(tokenFile(contents)).resolve()).toEqual({ status });
  });

  it("refuses an unfamiliar auth method rather than guessing", () => {
    const file = tokenFile({
      ...validToken("2035-01-01T00:00:00Z"),
      auth_method: "enterprise-sso",
    });

    expect(brokerFor(file).resolve()).toEqual({ status: "unsupported" });
  });

  it("accepts a token file with no expiry at all", () => {
    const file = tokenFile({ token: { access_token: "agy-access-token" } });

    expect(brokerFor(file).resolve()).toMatchObject({ status: "available" });
  });
});
