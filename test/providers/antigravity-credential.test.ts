import { describe, expect, it, vi } from "vitest";
import { createAntigravityCredentialBroker } from "../../src/providers/antigravity-credential.js";
import type { AgyCliCredentialResolution } from "../../src/providers/agy-cli-credential.js";
import type { PiAntigravityCredentialResolution } from "../../src/providers/pi-antigravity-credential.js";

function brokerWith(
  agyCli: AgyCliCredentialResolution,
  pi: PiAntigravityCredentialResolution,
) {
  return createAntigravityCredentialBroker({
    agyCli: { resolve: () => agyCli },
    pi: { resolve: async () => pi },
    agyCliPath: () => "/home/x/.gemini/antigravity-cli/antigravity-oauth-token",
    piPath: () => "/home/x/.pi/agent/auth.json",
  });
}

const AGY_LIVE: AgyCliCredentialResolution = {
  status: "available",
  credential: "agy-token",
  refreshable: true,
};
const PI_LIVE: PiAntigravityCredentialResolution = {
  status: "available",
  credential: "pi-token",
  refreshable: true,
  email: "someone@example.com",
};

describe("createAntigravityCredentialBroker", () => {
  it("prefers the agy CLI store, which is the one agy keeps current", async () => {
    const resolution = await brokerWith(AGY_LIVE, PI_LIVE).resolve();

    expect(resolution).toMatchObject({
      status: "available",
      credential: "agy-token",
      origin: "agy-cli",
      path: "/home/x/.gemini/antigravity-cli/antigravity-oauth-token",
    });
  });

  it("falls through to Pi when the agy CLI store is absent", async () => {
    const resolution = await brokerWith(
      { status: "missing" },
      PI_LIVE,
    ).resolve();

    expect(resolution).toMatchObject({
      status: "available",
      credential: "pi-token",
      origin: "pi",
      path: "/home/x/.pi/agent/auth.json",
      email: "someone@example.com",
    });
  });

  it("leaves a Pi-only machine behaving exactly as before", async () => {
    const resolution = await brokerWith(
      { status: "missing" },
      PI_LIVE,
    ).resolve();

    expect(resolution).toMatchObject({
      status: "available",
      credential: "pi-token",
    });
  });

  it("prefers a live Pi credential over a stored-expired agy one", async () => {
    const resolution = await brokerWith(
      { status: "expired", credential: "agy-token", refreshable: true },
      PI_LIVE,
    ).resolve();

    expect(resolution).toMatchObject({ origin: "pi", credential: "pi-token" });
  });

  it("uses a stored-expired credential rather than reporting nothing", async () => {
    const resolution = await brokerWith(
      { status: "expired", credential: "agy-token", refreshable: true },
      { status: "missing" },
    ).resolve();

    // Stored expiry is advisory: the quota call itself is the probe.
    expect(resolution).toMatchObject({
      status: "expired",
      credential: "agy-token",
      origin: "agy-cli",
    });
  });

  it("reports the more informative failure over a bare missing", async () => {
    const resolution = await brokerWith(
      { status: "missing" },
      { status: "invalid" },
    ).resolve();

    expect(resolution).toMatchObject({ status: "invalid", origin: "pi" });
  });

  it("reports missing only when both stores are absent", async () => {
    const resolution = await brokerWith(
      { status: "missing" },
      { status: "missing" },
    ).resolve();

    expect(resolution).toMatchObject({ status: "missing" });
  });

  it("survives a path resolver that throws", async () => {
    const broker = createAntigravityCredentialBroker({
      agyCli: { resolve: () => AGY_LIVE },
      pi: { resolve: async () => ({ status: "missing" }) },
      agyCliPath: () => {
        throw new Error("no home");
      },
      piPath: () => "/home/x/.pi/agent/auth.json",
    });

    expect(await broker.resolve()).toMatchObject({
      status: "available",
      origin: "agy-cli",
      path: undefined,
    });
  });

  it("resolves both stores so the better credential can win", async () => {
    const pi = vi.fn(async () => ({ status: "missing" }) as const);
    const broker = createAntigravityCredentialBroker({
      agyCli: { resolve: () => AGY_LIVE },
      pi: { resolve: pi },
      agyCliPath: () => "/agy",
      piPath: () => "/pi",
    });

    await broker.resolve();

    // Both are resolved so the better one can win; reading Pi's file is cheap
    // and read-only, and skipping it would break the fall-through ordering.
    expect(pi).toHaveBeenCalled();
  });
});
