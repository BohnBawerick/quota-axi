import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { usableLiteralSecret } from "../lib/secret.js";

const PI_PROVIDER_ID = "antigravity";
const AUTH_FILE_LIMIT_BYTES = 64 * 1024;

/**
 * Resolution of Pi's stored Antigravity credential.
 *
 * Stored expiry is advisory ordering, never a verdict: an `expired` record
 * still carries its access token so the read-only quota call can test it
 * empirically, mirroring `credential-selection.ts`. This reader never
 * refreshes the credential and never reads `refresh` for anything but the
 * refreshable flag.
 */
export type PiAntigravityCredentialResolution =
  | {
      status: "available" | "expired";
      /** Present only for in-memory probe use; never log or render. */
      credential: string;
      /** True only for `expired`; a stored refresh token exists. */
      refreshable: boolean;
      email?: string;
    }
  | { status: "missing" | "invalid" | "unsupported" | "error" };

export type PiAntigravityCredentialBroker = {
  resolve(): Promise<PiAntigravityCredentialResolution>;
};

type BrokerDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  now: () => number;
};

export function createPiAntigravityCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): PiAntigravityCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    now: () => Date.now(),
    ...overrides,
  };
  return { resolve: () => resolveCredential(dependencies) };
}

export function piAntigravityAuthFilePath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  homeDirectory: () => string = homedir,
): string {
  return authFilePath({
    environment,
    homeDirectory,
    readFile: readBoundedFile,
    now: () => Date.now(),
  });
}

async function resolveCredential(
  dependencies: BrokerDependencies,
): Promise<PiAntigravityCredentialResolution> {
  const path = authFilePath(dependencies);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, AUTH_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "error" };
  }
  if (contents.byteLength > AUTH_FILE_LIMIT_BYTES) {
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "error" };
  }

  const root = objectValue(parsed);
  if (!root) return { status: "invalid" };

  const entry = objectValue(root[PI_PROVIDER_ID]);
  if (!entry) return { status: "missing" };

  const type = stringValue(entry.type)?.toLowerCase();
  if (type !== undefined && type !== "oauth") return { status: "unsupported" };

  const access = usableLiteralSecret(entry.access);
  if (access === undefined) return { status: "invalid" };

  const email = stringValue(entry.email);
  const refreshable = usableLiteralSecret(entry.refresh) !== undefined;
  const hasExpiry = Object.hasOwn(entry, "expires");
  const expiresMs = timestampMs(entry.expires);
  if (hasExpiry && expiresMs === undefined) return { status: "invalid" };

  const expired = expiresMs !== undefined && expiresMs <= dependencies.now();
  return {
    status: expired ? "expired" : "available",
    credential: access,
    refreshable,
    ...(email ? { email } : {}),
  };
}

function authFilePath(dependencies: BrokerDependencies): string {
  return join(piAgentDirectory(dependencies), "auth.json");
}

function piAgentDirectory(dependencies: BrokerDependencies): string {
  const home = () =>
    nonempty(dependencies.environment.HOME) ?? dependencies.homeDirectory();
  const configured = nonempty(dependencies.environment.PI_CODING_AGENT_DIR);
  if (configured === undefined) {
    return join(home(), ".pi", "agent");
  }
  if (configured === "~") return home();
  if (
    configured.startsWith("~/") ||
    (process.platform === "win32" && configured.startsWith("~\\"))
  ) {
    return join(home(), configured.slice(2));
  }
  return configured;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Pi stores OAuth expiry as epoch milliseconds.
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const contents = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await file.read(
        contents,
        offset,
        contents.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return Buffer.from(contents.buffer, contents.byteOffset, offset);
  } finally {
    await file.close();
  }
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

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
