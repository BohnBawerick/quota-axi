import { describe, expect, it, vi } from "vitest";
import {
  discoverTokenEndpoint,
  performRefreshGrant,
  type RefreshGrant,
} from "../../src/lib/oauth-refresh.js";

const GRANT: RefreshGrant = {
  tokenUrl: "https://oauth2.example.com/token",
  clientId: "client-id-value",
  clientSecret: "client-secret-value",
  refreshToken: "refresh-token-value",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Every string a caller could accidentally leak into a report or a log. */
const SECRETS = [
  GRANT.clientSecret as string,
  GRANT.refreshToken,
  "rotated-refresh-token",
  "renewed-access-token",
];

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("performRefreshGrant", () => {
  it("renews and reports the rotated token and absolute expiry", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        access_token: "renewed-access-token",
        expires_in: 3600,
        refresh_token: "rotated-refresh-token",
        token_type: "Bearer",
      }),
    );

    const before = Date.now();
    const outcome = await performRefreshGrant(GRANT, fetchImpl as never);

    expect(outcome).toMatchObject({
      status: "renewed",
      accessToken: "renewed-access-token",
      refreshToken: "rotated-refresh-token",
    });
    if (outcome.status !== "renewed") throw new Error("unreachable");
    expect(outcome.expiresAtMs).toBeGreaterThanOrEqual(before + 3_600_000);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GRANT.tokenUrl);
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(GRANT.refreshToken);
    expect(body.get("client_id")).toBe(GRANT.clientId);
    expect(body.get("client_secret")).toBe(GRANT.clientSecret);
  });

  it("omits client_secret for a public client", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: "renewed-access-token" }),
    );

    const outcome = await performRefreshGrant(
      { ...GRANT, clientSecret: undefined },
      fetchImpl as never,
    );

    expect(outcome.status).toBe("renewed");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new URLSearchParams(init.body as string).has("client_secret")).toBe(
      false,
    );
  });

  it("omits expiry when the server does not state one", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: "renewed-access-token" }),
    );

    const outcome = await performRefreshGrant(GRANT, fetchImpl as never);

    expect(outcome).toEqual({
      status: "renewed",
      accessToken: "renewed-access-token",
    });
  });

  it.each([400, 401])("treats HTTP %i as a rejected grant", async (status) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: "invalid_grant",
          // Authorization servers really do echo the submitted token back.
          error_description: `Token ${GRANT.refreshToken} is expired`,
        },
        status,
      ),
    );

    const outcome = await performRefreshGrant(GRANT, fetchImpl as never);

    expect(outcome.status).toBe("rejected");
    expectNoSecret(JSON.stringify(outcome));
  });

  it.each([429, 500, 503])(
    "keeps HTTP %i transient rather than an auth verdict",
    async (status) => {
      const fetchImpl = vi.fn(async () => jsonResponse({}, status));

      const outcome = await performRefreshGrant(GRANT, fetchImpl as never);

      expect(outcome).toEqual({
        status: "unavailable",
        error: `token endpoint returned HTTP ${status}`,
      });
    },
  );

  it("reports a timeout as unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });

    const outcome = await performRefreshGrant(GRANT, fetchImpl as never);

    expect(outcome).toEqual({
      status: "unavailable",
      error: "token endpoint timed out",
    });
  });

  it("names the syscall for a transport failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
    });

    const outcome = await performRefreshGrant(GRANT, fetchImpl as never);

    expect(outcome).toEqual({
      status: "unavailable",
      error: "token endpoint unreachable (ECONNREFUSED)",
    });
  });

  it("rejects an oversized response instead of buffering it", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("x".repeat(64 * 1024 + 1), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const outcome = await performRefreshGrant(GRANT, fetchImpl as never);

    expect(outcome.status).toBe("unavailable");
  });

  it("treats a success payload without an access token as unavailable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token_type: "Bearer" }));

    const outcome = await performRefreshGrant(GRANT, fetchImpl as never);

    expect(outcome).toEqual({
      status: "unavailable",
      error: "token endpoint returned no access token",
    });
  });

  it("treats invalid JSON as unavailable", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not json", { status: 200 }),
    );

    const outcome = await performRefreshGrant(GRANT, fetchImpl as never);

    expect(outcome).toEqual({
      status: "unavailable",
      error: "token endpoint returned invalid JSON",
    });
  });
});

describe("discoverTokenEndpoint", () => {
  it("reads the advertised endpoint from the issuer document", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ token_endpoint: "https://auth.example.com/oauth2/token" }),
    );

    const endpoint = await discoverTokenEndpoint(
      "https://auth.example.com",
      fetchImpl as never,
    );

    expect(endpoint).toBe("https://auth.example.com/oauth2/token");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://auth.example.com/.well-known/openid-configuration",
    );
  });

  it("refuses a plaintext issuer", async () => {
    const fetchImpl = vi.fn();

    expect(
      await discoverTokenEndpoint(
        "http://auth.example.com",
        fetchImpl as never,
      ),
    ).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a plaintext token endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ token_endpoint: "http://auth.example.com/token" }),
    );

    expect(
      await discoverTokenEndpoint(
        "https://auth.example.com",
        fetchImpl as never,
      ),
    ).toBeUndefined();
  });

  it("returns undefined when discovery fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));

    expect(
      await discoverTokenEndpoint(
        "https://auth.example.com",
        fetchImpl as never,
      ),
    ).toBeUndefined();
  });
});
