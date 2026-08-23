import { updateCredentialFile } from "../lib/credential-writeback.js";
import {
  discoverTokenEndpoint,
  performRefreshGrant,
} from "../lib/oauth-refresh.js";
import { usableLiteralSecret } from "../lib/secret.js";
import { readJsonFile } from "../lib/fs.js";

/**
 * Renewal of the Grok CLI session credential through xAI's own OIDC grant.
 *
 * This is one of the two carve-outs VISION.md allows to the least-action rule:
 * the Grok CLI session token lives about six hours, and without renewal a
 * machine that has not opened `grok` today reports a sign-out and serves stale
 * windows, which is exactly the false headline fact the accuracy obligation
 * forbids.
 *
 * The refresh token is read from the auth file at the moment it is spent and
 * is never returned, retained, or plumbed through the credential-selection
 * candidate types, which deliberately carry refresh-token *presence* only.
 */
export type GrokRefreshOutcome =
  | { status: "renewed"; accessToken: string }
  /** xAI refused the grant: the stored refresh token is dead too. */
  | { status: "rejected" }
  /** Transient. Never allowed to become an authentication verdict. */
  | { status: "unavailable" }
  /** No refresh path on this record, so today's behaviour stands. */
  | { status: "not_configured" };

export type GrokRefreshRuntime = {
  fetch: typeof globalThis.fetch;
  /** The same file `readCredentialState` read the candidate from. */
  authFilePath: () => string;
};

/**
 * Renew one Grok CLI session credential and persist it.
 *
 * @param scope the record key the candidate came from (`issuer::client_id`),
 *   or undefined when the auth file holds a single unscoped record
 * @param runtime injected transport and path resolution
 * @returns the renewed access token, or a classified reason it did not happen
 */
export async function refreshGrokCliCredential(
  scope: string | undefined,
  runtime: GrokRefreshRuntime,
): Promise<GrokRefreshOutcome> {
  const file = runtime.authFilePath();
  const record = readRecord(file, scope);
  if (!record) return { status: "not_configured" };

  // Fingerprint the credential the refresh token was read beside. If another
  // `grok` login replaces it while the grant is in flight, that credential is
  // newer than ours and must not be overwritten.
  const originalKey = record.key;
  const refreshToken = usableLiteralSecret(
    record.refresh_token ?? record.refreshToken,
  );
  const issuer = literalString(record.oidc_issuer ?? record.oidcIssuer);
  const clientId = literalString(record.oidc_client_id ?? record.oidcClientId);
  if (!refreshToken || !issuer || !clientId)
    return { status: "not_configured" };

  const tokenUrl = await discoverTokenEndpoint(issuer, runtime.fetch);
  if (tokenUrl === undefined) return { status: "unavailable" };

  // xAI registers the CLI as a public client, so no client secret is sent.
  const outcome = await performRefreshGrant(
    { tokenUrl, clientId, refreshToken },
    runtime.fetch,
  );
  if (outcome.status === "rejected") return { status: "rejected" };
  if (outcome.status !== "renewed") return { status: "unavailable" };

  // A failed write-back is not a failed refresh: the renewed token is good for
  // this run either way, and the next run simply refreshes again.
  updateCredentialFile(file, (root) => {
    const target = recordIn(root, scope);
    if (!target || target.key !== originalKey) return undefined;
    const updated: Record<string, unknown> = {
      ...target,
      key: outcome.accessToken,
    };
    if (outcome.expiresAtMs !== undefined) {
      updated[
        "expires_at" in target || !("expiresAt" in target)
          ? "expires_at"
          : "expiresAt"
      ] = new Date(outcome.expiresAtMs).toISOString();
    }
    if (outcome.refreshToken !== undefined) {
      updated[
        "refresh_token" in target || !("refreshToken" in target)
          ? "refresh_token"
          : "refreshToken"
      ] = outcome.refreshToken;
    }
    return scope === undefined ? updated : { ...root, [scope]: updated };
  });

  return { status: "renewed", accessToken: outcome.accessToken };
}

function readRecord(
  file: string,
  scope: string | undefined,
): Record<string, unknown> | undefined {
  const root = objectValue(readJsonFile(file));
  return root ? recordIn(root, scope) : undefined;
}

function recordIn(
  root: Record<string, unknown>,
  scope: string | undefined,
): Record<string, unknown> | undefined {
  return scope === undefined ? root : objectValue(root[scope]);
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
