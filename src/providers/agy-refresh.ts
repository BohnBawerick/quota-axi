import { updateCredentialFile } from "../lib/credential-writeback.js";
import { readJsonFile } from "../lib/fs.js";
import { performRefreshGrant } from "../lib/oauth-refresh.js";
import { usableLiteralSecret } from "../lib/secret.js";
import { agyCliTokenFilePath } from "./agy-cli-credential.js";
import {
  GOOGLE_TOKEN_URL,
  resolveGoogleOAuthClient,
  type GoogleOAuthClient,
} from "./google-oauth-client.js";

/**
 * Renewal of the Antigravity credential through Google's own grant.
 *
 * Scoped deliberately to the agy CLI's own store. Pi's copy is left read-only:
 * Pi owns that file and refreshes it on its own schedule, and the accuracy
 * problem this solves is entirely about the store `agy` keeps. That keeps the
 * carve-out to VISION.md's least-action rule as small as it can be while still
 * making the report true.
 *
 * The refresh token is read at the moment it is spent and never returned or
 * retained, mirroring the Grok renewer.
 */
export type AgyRefreshOutcome =
  | { status: "renewed"; accessToken: string }
  /** Google refused the grant: re-authentication is the only remedy. */
  | { status: "rejected" }
  /** Transient. Never allowed to become an authentication verdict. */
  | { status: "unavailable" }
  /** No refresh token, or no configured OAuth client, so nothing was tried. */
  | { status: "not_configured" };

export type AgyRefreshRuntime = {
  fetch: typeof globalThis.fetch;
  tokenFilePath: () => string;
  resolveClient: () => GoogleOAuthClient | undefined;
};

export const defaultAgyRefreshRuntime: AgyRefreshRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  tokenFilePath: () => agyCliTokenFilePath(),
  resolveClient: () => resolveGoogleOAuthClient(),
};

/**
 * Renew the Antigravity access token and persist it to the agy CLI's store.
 *
 * @param runtime injected transport, path resolution, and client lookup
 * @returns the renewed access token, or a classified reason it did not happen
 */
export async function refreshAgyCliCredential(
  runtime: AgyRefreshRuntime = defaultAgyRefreshRuntime,
): Promise<AgyRefreshOutcome> {
  const client = runtime.resolveClient();
  if (client === undefined) return { status: "not_configured" };

  const file = runtime.tokenFilePath();
  const token = tokenRecord(file);
  if (!token) return { status: "not_configured" };

  const refreshToken = usableLiteralSecret(token.refresh_token);
  if (refreshToken === undefined) return { status: "not_configured" };

  // Fingerprint the access token the refresh token was read beside, so a
  // concurrent `agy` run that renews first is not overwritten by our result.
  const originalAccess = token.access_token;

  const outcome = await performRefreshGrant(
    {
      tokenUrl: GOOGLE_TOKEN_URL,
      clientId: client.clientId,
      ...(client.clientSecret !== undefined
        ? { clientSecret: client.clientSecret }
        : {}),
      refreshToken,
    },
    runtime.fetch,
  );
  if (outcome.status === "rejected") return { status: "rejected" };
  if (outcome.status !== "renewed") return { status: "unavailable" };

  // A failed write-back is not a failed refresh: the token is good for this
  // run either way, and the next run simply refreshes again.
  updateCredentialFile(file, (root) => {
    const current = objectValue(root.token);
    if (!current || current.access_token !== originalAccess) return undefined;
    const updated: Record<string, unknown> = {
      ...current,
      access_token: outcome.accessToken,
    };
    if (outcome.expiresAtMs !== undefined) {
      updated.expiry = new Date(outcome.expiresAtMs).toISOString();
    }
    if (outcome.refreshToken !== undefined) {
      updated.refresh_token = outcome.refreshToken;
    }
    return { ...root, token: updated };
  });

  return { status: "renewed", accessToken: outcome.accessToken };
}

function tokenRecord(file: string): Record<string, unknown> | undefined {
  const root = objectValue(readJsonFile(file));
  return root ? objectValue(root.token) : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
