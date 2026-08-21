import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLOUD_CODE_USER_AGENT,
  fetchCloudCodeQuotaSummary,
  type AgyCloudCodeRuntime,
} from "../../src/providers/agy-cloudcode.js";
import type { PiAntigravityCredentialResolution } from "../../src/providers/pi-antigravity-credential.js";

describe("Antigravity Cloud Code quota read", () => {
  it("reads the quota summary from a locally stored credential", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const runtime = runtimeWith({
      resolution: {
        status: "available",
        credential: "fixture-access-token",
        refreshable: true,
        email: "person@example.invalid",
      },
      respond: () => jsonResponse(200, fixture()),
      calls,
    });

    const result = await fetchCloudCodeQuotaSummary(runtime);

    expect(result).toMatchObject({
      status: "quota",
      email: "person@example.invalid",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    );
    expect(calls[0].init.method).toBe("POST");
    // A body that names no model and carries no prompt: this is the account's
    // quota-read surface, not an inference call.
    expect(calls[0].init.body).toBe("{}");
  });

  it("sends the product user agent the endpoint gates its licence check on", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await fetchCloudCodeQuotaSummary(
      runtimeWith({
        resolution: available(),
        respond: () => jsonResponse(200, fixture()),
        calls,
      }),
    );

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(CLOUD_CODE_USER_AGENT);
    expect(CLOUD_CODE_USER_AGENT).toContain("antigravity");
    expect(CLOUD_CODE_USER_AGENT).toContain("quota-axi");
    expect(headers.Authorization).toBe("Bearer fixture-access-token");
  });

  it("probes a stored-expired credential instead of pre-judging it", async () => {
    const runtime = runtimeWith({
      resolution: {
        status: "expired",
        credential: "fixture-access-token",
        refreshable: true,
      },
      respond: () => jsonResponse(200, fixture()),
    });

    const result = await fetchCloudCodeQuotaSummary(runtime);

    expect(result.status).toBe("quota");
  });

  it("reports a rejected stored-expired credential as refreshable expiry", async () => {
    const result = await fetchCloudCodeQuotaSummary(
      runtimeWith({
        resolution: {
          status: "expired",
          credential: "fixture-access-token",
          refreshable: true,
        },
        respond: () => jsonResponse(401, { error: { code: 401 } }),
      }),
    );

    expect(result).toEqual({
      status: "auth_rejected",
      error: "Antigravity access token expired",
      storedExpired: true,
      refreshable: true,
    });
  });

  it("reports a rejected unexpired credential as sign-in required", async () => {
    const result = await fetchCloudCodeQuotaSummary(
      runtimeWith({
        resolution: available(),
        respond: () => jsonResponse(401, { error: { code: 401 } }),
      }),
    );

    expect(result).toMatchObject({
      status: "auth_rejected",
      error: "Antigravity sign-in required",
      storedExpired: false,
    });
  });

  it("separates an entitlement refusal from a credential problem", async () => {
    const result = await fetchCloudCodeQuotaSummary(
      runtimeWith({
        resolution: available(),
        respond: () =>
          jsonResponse(403, {
            error: { code: 403, message: "You do not have a valid license" },
          }),
      }),
    );

    expect(result).toEqual({
      status: "not_entitled",
      error: "Antigravity account is not licensed for Antigravity quota",
    });
  });

  it("reports rate limiting and transport failures as unavailable", async () => {
    expect(
      await fetchCloudCodeQuotaSummary(
        runtimeWith({
          resolution: available(),
          respond: () => jsonResponse(429, {}),
        }),
      ),
    ).toEqual({ status: "rate_limited" });

    expect(
      await fetchCloudCodeQuotaSummary(
        runtimeWith({
          resolution: available(),
          respond: () => {
            throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
          },
        }),
      ),
    ).toEqual({
      status: "unavailable",
      error: "Antigravity quota endpoint unreachable (ECONNREFUSED)",
    });
  });

  it("reports a non-JSON body as unavailable rather than as quota", async () => {
    const result = await fetchCloudCodeQuotaSummary(
      runtimeWith({
        resolution: available(),
        respond: () => new Response("<html>nope</html>", { status: 200 }),
      }),
    );

    expect(result).toEqual({
      status: "unavailable",
      error: "Antigravity quota endpoint returned invalid JSON",
    });
  });

  it("never calls the endpoint without a usable credential", async () => {
    for (const [resolution, expected] of [
      [{ status: "missing" } as const, { status: "credential_missing" }],
      [
        { status: "invalid" } as const,
        { status: "credential_unusable", error: "invalid_credential" },
      ],
      [
        { status: "unsupported" } as const,
        { status: "credential_unusable", error: "unsupported_credential_type" },
      ],
      [
        { status: "error" } as const,
        {
          status: "credential_unusable",
          error: "credential_resolution_failed",
        },
      ],
    ] as const) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const result = await fetchCloudCodeQuotaSummary(
        runtimeWith({
          resolution,
          respond: () => jsonResponse(200, fixture()),
          calls,
        }),
      );

      expect(result).toEqual(expected);
      expect(calls).toHaveLength(0);
    }
  });
});

function available(): PiAntigravityCredentialResolution {
  return {
    status: "available",
    credential: "fixture-access-token",
    refreshable: true,
  };
}

function runtimeWith(options: {
  resolution: PiAntigravityCredentialResolution;
  respond: () => Response;
  calls?: Array<{ url: string; init: RequestInit }>;
}): AgyCloudCodeRuntime {
  return {
    credentials: { resolve: async () => options.resolution },
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      options.calls?.push({ url: String(input), init });
      return options.respond();
    }) as typeof globalThis.fetch,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixture(): unknown {
  return JSON.parse(
    readFileSync(
      join("test", "fixtures", "agy", "cloudcode-quota-summary.json"),
      "utf8",
    ),
  ) as unknown;
}
