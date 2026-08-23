import { usableLiteralSecret } from "../lib/secret.js";

/**
 * The OAuth client Antigravity's own sign-in uses.
 *
 * Google's refresh grant needs a client id, and for an installed-application
 * client also its secret. Neither is stored beside the token: they belong to
 * the Antigravity CLI. Renewing Antigravity's credential through Antigravity's
 * own first-party grant is the carve-out VISION.md allows, and using a
 * different client for it would not be, so the pair has to be Antigravity's.
 *
 * quota-axi takes them from the environment and does not go looking for them
 * itself. Reading another vendor's binary for a credential is not a thing this
 * tool should do quietly on someone's machine, and a build-specific scrape
 * would rot on the next `agy update` anyway. When the variables are unset the
 * renewal reports `not_configured` and the provider behaves exactly as it did
 * before, which keeps this additive.
 *
 * Nothing here is logged, rendered, cached to disk, or written to a fixture.
 */
export type GoogleOAuthClient = {
  clientId: string;
  /** Absent for a public (PKCE) client, which refreshes without a secret. */
  clientSecret?: string;
};

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const ANTIGRAVITY_CLIENT_ID_VAR =
  "QUOTA_AXI_ANTIGRAVITY_OAUTH_CLIENT_ID";
export const ANTIGRAVITY_CLIENT_SECRET_VAR =
  "QUOTA_AXI_ANTIGRAVITY_OAUTH_CLIENT_SECRET";

/**
 * @param environment process environment to read the client from
 * @returns the configured client, or undefined when renewal is not configured
 */
export function resolveGoogleOAuthClient(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GoogleOAuthClient | undefined {
  const clientId = usableLiteralSecret(environment[ANTIGRAVITY_CLIENT_ID_VAR]);
  if (clientId === undefined) return undefined;
  const clientSecret = usableLiteralSecret(
    environment[ANTIGRAVITY_CLIENT_SECRET_VAR],
  );
  return {
    clientId,
    ...(clientSecret !== undefined ? { clientSecret } : {}),
  };
}
