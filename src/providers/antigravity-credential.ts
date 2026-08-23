import {
  agyCliTokenFilePath,
  createAgyCliCredentialBroker,
  type AgyCliCredentialBroker,
} from "./agy-cli-credential.js";
import {
  createPiAntigravityCredentialBroker,
  piAntigravityAuthFilePath,
  type PiAntigravityCredentialBroker,
} from "./pi-antigravity-credential.js";

/** Which store a credential came from, so a renewal writes back to it. */
export type AntigravityCredentialOrigin = "agy-cli" | "pi";

/**
 * Structurally a superset of `PiAntigravityCredentialResolution`: `origin` and
 * `path` are optional so a test double that returns the plain Pi shape still
 * satisfies this type.
 */
export type AntigravityCredentialResolution =
  | {
      status: "available" | "expired";
      credential: string;
      refreshable: boolean;
      email?: string;
      origin?: AntigravityCredentialOrigin;
      path?: string;
    }
  | {
      status: "missing" | "invalid" | "unsupported" | "error";
      origin?: AntigravityCredentialOrigin;
      path?: string;
    };

export type AntigravityCredentialBroker = {
  resolve(): Promise<AntigravityCredentialResolution>;
};

type BrokerDependencies = {
  agyCli: AgyCliCredentialBroker;
  pi: PiAntigravityCredentialBroker;
  agyCliPath: () => string;
  piPath: () => string;
};

/**
 * Resolve the Antigravity credential from the agy CLI store first, then Pi's.
 *
 * Order matters and additivity matters. The agy CLI store is refreshed on
 * every `agy` run, so it is the live copy wherever Antigravity is actually
 * used; Pi's copy is only current on a machine that runs Pi. Neither path is
 * removed: a first source that is missing or unreadable falls through, so a
 * Pi-only machine behaves exactly as it did before.
 *
 * A usable credential always beats an unusable one, and a stored-valid one
 * beats a stored-expired one. Stored expiry only orders the two stores; it
 * never rejects a credential, because the quota call itself is the probe.
 */
export function createAntigravityCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): AntigravityCredentialBroker {
  const dependencies: BrokerDependencies = {
    agyCli: createAgyCliCredentialBroker(),
    pi: createPiAntigravityCredentialBroker(),
    agyCliPath: () => agyCliTokenFilePath(),
    piPath: () => piAntigravityAuthFilePath(),
    ...overrides,
  };
  return { resolve: () => resolve(dependencies) };
}

async function resolve(
  dependencies: BrokerDependencies,
): Promise<AntigravityCredentialResolution> {
  const candidates: AntigravityCredentialResolution[] = [
    withSource(
      dependencies.agyCli.resolve(),
      "agy-cli",
      dependencies.agyCliPath,
    ),
    withSource(await dependencies.pi.resolve(), "pi", dependencies.piPath),
  ];

  return (
    candidates.find((candidate) => candidate.status === "available") ??
    candidates.find((candidate) => candidate.status === "expired") ??
    // Report the most informative failure rather than a bare `missing`: a file
    // that exists but cannot be parsed is a different problem for the user
    // than no file at all.
    candidates.find((candidate) => candidate.status !== "missing") ??
    candidates[0]!
  );
}

function withSource(
  resolution: AntigravityCredentialResolution,
  origin: AntigravityCredentialOrigin,
  path: () => string,
): AntigravityCredentialResolution {
  return { ...resolution, origin, path: safePath(path) };
}

function safePath(path: () => string): string | undefined {
  try {
    return path();
  } catch {
    return undefined;
  }
}
