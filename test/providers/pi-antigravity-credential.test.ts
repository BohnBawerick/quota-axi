import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPiAntigravityCredentialBroker,
  piAntigravityAuthFilePath,
} from "../../src/providers/pi-antigravity-credential.js";

const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
let temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Pi Antigravity credential broker", () => {
  it("reads the antigravity oauth entry from the default Pi agent auth file", async () => {
    const home = temporaryDirectory();
    writeAuth(join(home, ".pi", "agent", "auth.json"), {
      antigravity: {
        type: "oauth",
        access: "fixture-access-token",
        refresh: "fixture-refresh-token",
        email: "person@example.invalid",
        expires: Date.now() + 3_600_000,
      },
    });
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;

    const resolution = await broker(home).resolve();

    expect(resolution).toEqual({
      status: "available",
      credential: "fixture-access-token",
      refreshable: true,
      email: "person@example.invalid",
    });
  });

  it("honours PI_CODING_AGENT_DIR for the auth file location", async () => {
    const directory = temporaryDirectory();
    writeAuth(join(directory, "auth.json"), {
      antigravity: { type: "oauth", access: "fixture-access-token" },
    });
    process.env.PI_CODING_AGENT_DIR = directory;

    expect(piAntigravityAuthFilePath(process.env, () => directory)).toBe(
      join(directory, "auth.json"),
    );
    expect(await broker(directory).resolve()).toEqual({
      status: "available",
      credential: "fixture-access-token",
      refreshable: false,
    });
  });

  it("keeps a stored-expired credential so the quota read can probe it", async () => {
    const home = temporaryDirectory();
    writeAuth(join(home, ".pi", "agent", "auth.json"), {
      antigravity: {
        type: "oauth",
        access: "fixture-access-token",
        refresh: "fixture-refresh-token",
        expires: Date.now() - 1_000,
      },
    });
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;

    expect(await broker(home).resolve()).toEqual({
      status: "expired",
      credential: "fixture-access-token",
      refreshable: true,
    });
  });

  it("reports a missing file and a missing antigravity entry as missing", async () => {
    const empty = temporaryDirectory();
    process.env.PI_CODING_AGENT_DIR = empty;
    expect(await broker(empty).resolve()).toEqual({ status: "missing" });

    const populated = temporaryDirectory();
    writeAuth(join(populated, "auth.json"), { xai: { type: "api_key" } });
    process.env.PI_CODING_AGENT_DIR = populated;
    expect(await broker(populated).resolve()).toEqual({ status: "missing" });
  });

  it("rejects non-literal, non-oauth, and malformed records", async () => {
    for (const [entry, expected] of [
      [{ type: "oauth", access: "$ANTIGRAVITY_TOKEN" }, "invalid"],
      [{ type: "oauth", access: "!op read secret" }, "invalid"],
      [{ type: "oauth" }, "invalid"],
      [
        { type: "oauth", access: "fixture-access-token", expires: "soon" },
        "invalid",
      ],
      [{ type: "api_key", key: "fixture" }, "unsupported"],
    ] as const) {
      const directory = temporaryDirectory();
      writeAuth(join(directory, "auth.json"), { antigravity: entry });
      process.env.PI_CODING_AGENT_DIR = directory;

      expect((await broker(directory).resolve()).status).toBe(expected);
    }
  });

  it("reports unreadable JSON as an error rather than a sign-out", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "auth.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json", "utf8");
    process.env.PI_CODING_AGENT_DIR = directory;

    expect(await broker(directory).resolve()).toEqual({ status: "error" });
  });
});

function broker(home: string) {
  return createPiAntigravityCredentialBroker({
    environment: process.env,
    homeDirectory: () => home,
  });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-pi-agy-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAuth(path: string, contents: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(contents), "utf8");
}
