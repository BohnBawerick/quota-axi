import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshGrokCliCredential } from "../../src/providers/grok-refresh.js";

const SCOPE = "https://auth.x.ai::client-abc";
const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function authFile(
  record: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-grok-refresh-"));
  const file = join(tempDir, "auth.json");
  writeFileSync(
    file,
    `${JSON.stringify({ [SCOPE]: record, ...extra }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  return file;
}

function validRecord(): Record<string, unknown> {
  return {
    key: "expired-access-token",
    auth_mode: "oidc",
    expires_at: "2020-01-01T00:00:00.000Z",
    refresh_token: "stored-refresh-token",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "client-abc",
    email: "someone@example.com",
    team_id: "team-1",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Discovery answers first, then the token endpoint answers `token`. */
function runtimeWith(file: string, token: (body: URLSearchParams) => Response) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url === DISCOVERY_URL) return json({ token_endpoint: TOKEN_URL });
    if (url === TOKEN_URL)
      return token(new URLSearchParams(String(init?.body ?? "")));
    throw new Error(`unexpected url ${url}`);
  });
  return {
    runtime: { fetch: fetchImpl as never, authFilePath: () => file },
    calls,
    fetchImpl,
  };
}

describe("refreshGrokCliCredential", () => {
  it("renews and writes the new token back into its own record", async () => {
    const file = authFile(validRecord(), { other: { key: "untouched" } });
    const { runtime, calls } = runtimeWith(file, () =>
      json({ access_token: "renewed-access-token", expires_in: 21600 }),
    );

    const outcome = await refreshGrokCliCredential(SCOPE, runtime);

    expect(outcome).toEqual({
      status: "renewed",
      accessToken: "renewed-access-token",
    });
    expect(calls).toEqual([DISCOVERY_URL, TOKEN_URL]);

    const written = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(written[SCOPE]?.key).toBe("renewed-access-token");
    expect(written[SCOPE]?.expires_at).not.toBe("2020-01-01T00:00:00.000Z");
    // Everything the grant did not speak to survives untouched.
    expect(written[SCOPE]?.email).toBe("someone@example.com");
    expect(written[SCOPE]?.team_id).toBe("team-1");
    expect(written[SCOPE]?.oidc_client_id).toBe("client-abc");
    expect(written.other).toEqual({ key: "untouched" });
  });

  it("spends the stored refresh token as a public client", async () => {
    const file = authFile(validRecord());
    let body: URLSearchParams | undefined;
    const { runtime } = runtimeWith(file, (parsed) => {
      body = parsed;
      return json({ access_token: "renewed-access-token" });
    });

    await refreshGrokCliCredential(SCOPE, runtime);

    expect(body?.get("grant_type")).toBe("refresh_token");
    expect(body?.get("refresh_token")).toBe("stored-refresh-token");
    expect(body?.get("client_id")).toBe("client-abc");
    expect(body?.has("client_secret")).toBe(false);
  });

  it("persists a rotated refresh token so the next run still works", async () => {
    const file = authFile(validRecord());
    const { runtime } = runtimeWith(file, () =>
      json({ access_token: "renewed", refresh_token: "rotated-refresh-token" }),
    );

    await refreshGrokCliCredential(SCOPE, runtime);

    const written = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(written[SCOPE]?.refresh_token).toBe("rotated-refresh-token");
  });

  it("reports a refused grant as rejected and leaves the file alone", async () => {
    const file = authFile(validRecord());
    const before = readFileSync(file, "utf8");
    const { runtime } = runtimeWith(file, () =>
      json({ error: "invalid_grant" }, 400),
    );

    expect(await refreshGrokCliCredential(SCOPE, runtime)).toEqual({
      status: "rejected",
    });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps a server failure transient", async () => {
    const file = authFile(validRecord());
    const { runtime } = runtimeWith(file, () => json({}, 503));

    expect(await refreshGrokCliCredential(SCOPE, runtime)).toEqual({
      status: "unavailable",
    });
  });

  it("reports unavailable when discovery fails, without spending the token", async () => {
    const file = authFile(validRecord());
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === DISCOVERY_URL) return json({}, 500);
      throw new Error("token endpoint must not be called");
    });

    expect(
      await refreshGrokCliCredential(SCOPE, {
        fetch: fetchImpl as never,
        authFilePath: () => file,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it.each([
    ["refresh_token", "no refresh token"],
    ["oidc_issuer", "no issuer"],
    ["oidc_client_id", "no client id"],
  ])("reports not_configured with %s missing", async (field) => {
    const record = validRecord();
    delete record[field];
    const file = authFile(record);
    const fetchImpl = vi.fn(async () => {
      throw new Error("must not reach the network");
    });

    expect(
      await refreshGrokCliCredential(SCOPE, {
        fetch: fetchImpl as never,
        authFilePath: () => file,
      }),
    ).toEqual({ status: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports not_configured when the auth file is absent", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-grok-refresh-"));
    const fetchImpl = vi.fn();

    expect(
      await refreshGrokCliCredential(SCOPE, {
        fetch: fetchImpl as never,
        authFilePath: () => join(tempDir!, "absent.json"),
      }),
    ).toEqual({ status: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still renews when a concurrent login blocks the write-back", async () => {
    const file = authFile(validRecord());
    const { runtime } = runtimeWith(file, () => {
      // Another `grok` login lands between our read and our write.
      writeFileSync(file, JSON.stringify({ [SCOPE]: { key: "newer" } }));
      return json({ access_token: "renewed-access-token" });
    });

    expect(await refreshGrokCliCredential(SCOPE, runtime)).toEqual({
      status: "renewed",
      accessToken: "renewed-access-token",
    });
    // The newer credential wins on disk; ours is used only for this run.
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(written[SCOPE]?.key).toBe("newer");
  });
});
