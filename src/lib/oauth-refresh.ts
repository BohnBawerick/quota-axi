const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * One first-party `refresh_token` grant. `clientSecret` is optional because a
 * public OIDC client (Grok's `auth.x.ai` registration) refreshes without one,
 * while an installed-app client (Antigravity's Google registration) requires
 * the pair its own vendor ships.
 */
export type RefreshGrant = {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
};

/**
 * Modelled as data rather than thrown errors so each caller maps an outcome to
 * a provider verdict without unwrapping error classes across module
 * boundaries, matching `AgyCloudCodeResult`.
 *
 * `rejected` means the authorization server refused the grant, so the stored
 * credential is genuinely dead and re-authentication is the only remedy.
 * `unavailable` is transient (transport, timeout, 5xx) and must never become
 * an auth verdict. `not_configured` means quota-axi could not assemble a
 * grant at all, which is a quota-axi gap and not a statement about the user.
 */
export type RefreshOutcome =
  | {
      status: "renewed";
      accessToken: string;
      /** Absent when the server omits `expires_in`. */
      expiresAtMs?: number;
      /** Present only when the server rotated the refresh token. */
      refreshToken?: string;
    }
  | { status: "rejected"; error: string }
  | { status: "unavailable"; error: string }
  | { status: "not_configured"; error: string };

/**
 * Execute a `refresh_token` grant and return the renewed values.
 *
 * No field of the grant, and no part of the response body, is ever returned in
 * an error string, logged, or retained: an authorization server routinely
 * echoes the submitted token back inside its error description, so error text
 * is reduced to a fixed vocabulary before it leaves this function.
 *
 * @param grant the token endpoint and the credential material to spend
 * @param fetchImpl injected so tests substitute transport
 * @returns the renewed credential, or a classified failure
 */
export async function performRefreshGrant(
  grant: RefreshGrant,
  fetchImpl: typeof globalThis.fetch,
): Promise<RefreshOutcome> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: grant.refreshToken,
    client_id: grant.clientId,
  });
  if (grant.clientSecret !== undefined) {
    body.set("client_secret", grant.clientSecret);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(grant.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    return { status: "unavailable", error: transportError(error) };
  } finally {
    clearTimeout(timer);
  }

  // 400 and 401 are the RFC 6749 refusals: the grant itself is bad, so the
  // stored refresh token will not work on a later run either. Everything else
  // that is not ok stays transient.
  if (response.status === 400 || response.status === 401) {
    return { status: "rejected", error: "refresh_token_rejected" };
  }
  if (!response.ok) {
    return {
      status: "unavailable",
      error: `token endpoint returned HTTP ${response.status}`,
    };
  }

  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (error) {
    return { status: "unavailable", error: transportError(error) };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return {
      status: "unavailable",
      error: "token endpoint returned invalid JSON",
    };
  }

  const root = objectValue(payload);
  const accessToken = literalString(root?.access_token);
  if (accessToken === undefined) {
    return {
      status: "unavailable",
      error: "token endpoint returned no access token",
    };
  }

  const expiresInSeconds = finiteNumber(root?.expires_in);
  const rotated = literalString(root?.refresh_token);
  return {
    status: "renewed",
    accessToken,
    ...(expiresInSeconds !== undefined
      ? { expiresAtMs: Date.now() + expiresInSeconds * 1000 }
      : {}),
    ...(rotated !== undefined ? { refreshToken: rotated } : {}),
  };
}

/**
 * Read the OIDC token endpoint from an issuer's discovery document, so a
 * vendor that moves its endpoint does not silently break the refresh.
 *
 * @param issuer the `oidc_issuer` recorded alongside the credential
 * @param fetchImpl injected so tests substitute transport
 * @returns the advertised token endpoint, or undefined when discovery fails
 */
export async function discoverTokenEndpoint(
  issuer: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(
      ".well-known/openid-configuration",
      ensureTrailingSlash(issuer),
    );
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const document = objectValue(JSON.parse(await readBoundedText(response)));
    const endpoint = literalString(document?.token_endpoint);
    if (endpoint === undefined) return undefined;
    return new URL(endpoint).protocol === "https:" ? endpoint : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function readBoundedText(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("token response too large");
  }
  return Buffer.from(buffer).toString("utf8");
}

function transportError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "token endpoint timed out";
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)) {
    return `token endpoint unreachable (${code})`;
  }
  return "token endpoint unreachable";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function literalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
