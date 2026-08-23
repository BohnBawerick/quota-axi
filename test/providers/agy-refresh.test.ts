import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAgyCliCredential } from "../../src/providers/agy-refresh.js";
import {
  ANTIGRAVITY_CLIENT_ID_VAR,
  ANTIGRAVITY_CLIENT_SECRET_VAR,
  resolveGoogleOAuthClient,
} from "../../src/providers/google-oauth-client.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function tokenFile(token: Record<string, unknown>): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-agy-refresh-"));
  const file = join(tempDir, "antigravity-oauth-token");
  writeFileSync(
    file,
    `${JSON.stringify({ token, auth_method: "consumer" }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return file;
}

function validToken(): Record<string, unknown> {
  return {
    access_token: "expired-access-token",
    token_type: "Bearer",
    refresh_token: "stored-refresh-token",
    expiry: "2020-01-01T00:00:00Z",
  };
}

const CLIENT = { clientId: "client-id", clientSecret: "client-secret" };

function runtimeFor(
  file: string,
  respond: (body: URLSearchParams) => Response,
  // `null` means "no client configured"; passing `undefined` would re-apply
  // the default parameter instead.
  client: typeof CLIENT | null = CLIENT,
) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(TOKEN_URL);
    return respond(new URLSearchParams(String(init?.body ?? "")));
  });
  return {
    fetchImpl,
    runtime: {
      fetch: fetchImpl as never,
      tokenFilePath: () => file,
      resolveClient: () => client ?? undefined,
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveGoogleOAuthClient", () => {
  it("reads the configured client from the environment", () => {
    expect(
      resolveGoogleOAuthClient({
        [ANTIGRAVITY_CLIENT_ID_VAR]: "id",
        [ANTIGRAVITY_CLIENT_SECRET_VAR]: "secret",
      }),
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("supports a public client with no secret", () => {
    expect(
      resolveGoogleOAuthClient({ [ANTIGRAVITY_CLIENT_ID_VAR]: "id" }),
    ).toEqual({ clientId: "id" });
  });

  it("is undefined when nothing is configured", () => {
    expect(resolveGoogleOAuthClient({})).toBeUndefined();
  });
});

describe("refreshAgyCliCredential", () => {
  it("renews and writes the token back into the agy CLI store", async () => {
    const file = tokenFile(validToken());
    const { runtime } = runtimeFor(file, () =>
      json({ access_token: "renewed-access-token", expires_in: 3600 }),
    );

    expect(await refreshAgyCliCredential(runtime)).toEqual({
      status: "renewed",
      accessToken: "renewed-access-token",
    });

    const written = JSON.parse(readFileSync(file, "utf8")) as {
      token: Record<string, unknown>;
      auth_method: string;
    };
    expect(written.token.access_token).toBe("renewed-access-token");
    expect(written.token.expiry).not.toBe("2020-01-01T00:00:00Z");
    expect(written.token.refresh_token).toBe("stored-refresh-token");
    expect(written.token.token_type).toBe("Bearer");
    expect(written.auth_method).toBe("consumer");
  });

  it("sends the configured client with the stored refresh token", async () => {
    const file = tokenFile(validToken());
    let body: URLSearchParams | undefined;
    const { runtime } = runtimeFor(file, (parsed) => {
      body = parsed;
      return json({ access_token: "renewed" });
    });

    await refreshAgyCliCredential(runtime);

    expect(body?.get("grant_type")).toBe("refresh_token");
    expect(body?.get("refresh_token")).toBe("stored-refresh-token");
    expect(body?.get("client_id")).toBe("client-id");
    expect(body?.get("client_secret")).toBe("client-secret");
  });

  it("persists a rotated refresh token", async () => {
    const file = tokenFile(validToken());
    const { runtime } = runtimeFor(file, () =>
      json({ access_token: "renewed", refresh_token: "rotated" }),
    );

    await refreshAgyCliCredential(runtime);

    const written = JSON.parse(readFileSync(file, "utf8")) as {
      token: Record<string, unknown>;
    };
    expect(written.token.refresh_token).toBe("rotated");
  });

  it("does nothing when no OAuth client is configured", async () => {
    const file = tokenFile(validToken());
    const { runtime, fetchImpl } = runtimeFor(
      file,
      () => json({ access_token: "renewed" }),
      null,
    );

    expect(await refreshAgyCliCredential(runtime)).toEqual({
      status: "not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing when the store holds no refresh token", async () => {
    const file = tokenFile({ access_token: "expired-access-token" });
    const { runtime, fetchImpl } = runtimeFor(file, () =>
      json({ access_token: "renewed" }),
    );

    expect(await refreshAgyCliCredential(runtime)).toEqual({
      status: "not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a refused grant as rejected and leaves the store alone", async () => {
    const file = tokenFile(validToken());
    const before = readFileSync(file, "utf8");
    const { runtime } = runtimeFor(file, () =>
      json({ error: "invalid_grant" }, 400),
    );

    expect(await refreshAgyCliCredential(runtime)).toEqual({
      status: "rejected",
    });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps a server failure transient", async () => {
    const file = tokenFile(validToken());
    const { runtime } = runtimeFor(file, () => json({}, 500));

    expect(await refreshAgyCliCredential(runtime)).toEqual({
      status: "unavailable",
    });
  });

  it("does not overwrite a token a concurrent agy run renewed first", async () => {
    const file = tokenFile(validToken());
    const { runtime } = runtimeFor(file, () => {
      writeFileSync(
        file,
        JSON.stringify({ token: { access_token: "newer-from-agy" } }),
      );
      return json({ access_token: "renewed-access-token" });
    });

    expect(await refreshAgyCliCredential(runtime)).toEqual({
      status: "renewed",
      accessToken: "renewed-access-token",
    });
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      token: Record<string, unknown>;
    };
    expect(written.token.access_token).toBe("newer-from-agy");
  });
});

describe("credential hygiene", () => {
  it("ships no OAuth client literal in the source tree", () => {
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => join("src", entry));
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // A Google installed-app client secret and a concrete client id must be
      // supplied by the operator, never baked in.
      expect(source, file).not.toMatch(/GOCSPX-[A-Za-z0-9_-]{10,}/);
      expect(source, file).not.toMatch(/[0-9]{6,}-[a-z0-9]{16,}\.apps\./);
    }
  });
});
