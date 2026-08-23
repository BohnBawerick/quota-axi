import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import { usableLiteralSecret } from "../lib/secret.js";

/**
 * The Antigravity CLI's own OAuth token store.
 *
 * `agy` refreshes this file on every run and Pi never touches it, so on a
 * machine that runs `agy` and not Pi it is the only live copy of the
 * credential. Pi's store is the one quota-axi read first historically, and it
 * goes stale the moment the user stops running Pi, which is what made
 * Antigravity vanish from the report entirely.
 *
 * Read-only here, exactly like the Pi reader: stored expiry is advisory
 * ordering, and the refresh token is reported as presence only.
 */
const DEFAULT_RELATIVE_PATH = [
  ".gemini",
  "antigravity-cli",
  "antigravity-oauth-token",
];

export type AgyCliCredentialResolution =
  | {
      status: "available" | "expired";
      /** Present only for in-memory probe use; never log or render. */
      credential: string;
      /** True when a stored refresh token exists beside the access token. */
      refreshable: boolean;
    }
  | { status: "missing" | "invalid" | "unsupported" | "error" };

export type AgyCliCredentialBroker = {
  resolve(): AgyCliCredentialResolution;
};

type BrokerDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  now: () => number;
};

export function agyCliTokenFilePath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory: () => string = homedir,
): string {
  const configured = nonempty(environment.QUOTA_AXI_AGY_CLI_TOKEN_FILE);
  if (configured !== undefined) return configured;
  const home = nonempty(environment.HOME) ?? homeDirectory();
  return join(home, ...DEFAULT_RELATIVE_PATH);
}

export function createAgyCliCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): AgyCliCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    now: () => Date.now(),
    ...overrides,
  };
  return { resolve: () => resolveCredential(dependencies) };
}

function resolveCredential(
  dependencies: BrokerDependencies,
): AgyCliCredentialResolution {
  const file = agyCliTokenFilePath(
    dependencies.environment,
    dependencies.homeDirectory,
  );
  const read = readJsonFileResult(file);
  if (read.status === "missing") return { status: "missing" };
  if (read.status === "invalid") return { status: "error" };

  const root = objectValue(read.value);
  if (!root) return { status: "invalid" };

  // `auth_method` names how the user signed in (`consumer` for a personal
  // Google account). An unfamiliar value is reported rather than guessed at.
  const authMethod = stringValue(root.auth_method)?.toLowerCase();
  if (authMethod !== undefined && authMethod !== "consumer") {
    return { status: "unsupported" };
  }

  const token = objectValue(root.token);
  if (!token) return { status: "invalid" };

  const credential = usableLiteralSecret(token.access_token);
  if (credential === undefined) return { status: "invalid" };

  const refreshable = usableLiteralSecret(token.refresh_token) !== undefined;
  const hasExpiry = Object.hasOwn(token, "expiry");
  const expiresMs = timestampMs(token.expiry);
  if (hasExpiry && expiresMs === undefined) return { status: "invalid" };

  const expired = expiresMs !== undefined && expiresMs <= dependencies.now();
  return {
    status: expired ? "expired" : "available",
    credential,
    refreshable,
  };
}

/** The agy CLI stores expiry as an RFC 3339 string with an offset. */
function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function nonempty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
