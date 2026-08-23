import { VERSION } from "../version.js";
import {
  createAntigravityCredentialBroker,
  type AntigravityCredentialBroker,
  type AntigravityCredentialResolution,
} from "./antigravity-credential.js";

/**
 * Antigravity's own quota-read RPC, reached directly instead of through a
 * running Antigravity language server. It is the same operation the loopback
 * path calls (`RetrieveUserQuotaSummary`): it names no model, carries no
 * prompt, and returns the account's remaining fractions, so reading it does
 * not consume model tokens or request allowance.
 */
const QUOTA_SUMMARY_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CLIENT_METADATA = {
  ideType: "ANTIGRAVITY",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

/**
 * The endpoint gates the Antigravity product licence on the client's user
 * agent and answers HTTP 403 without it. Observed behaviour: it only requires
 * the product name, not a version, so quota-axi names the product it is
 * reading and then identifies itself truthfully rather than impersonating a
 * specific Antigravity release.
 */
export const CLOUD_CODE_USER_AGENT = `antigravity quota-axi/${VERSION}`;

/**
 * Outcome of the direct read. Modelled as data rather than thrown errors so
 * the adapter can map each case to a provider verdict without unwrapping
 * error classes across module boundaries.
 */
export type AgyCloudCodeResult =
  | { status: "quota"; summary: unknown; email?: string }
  | { status: "credential_missing" }
  | { status: "credential_unusable"; error: string }
  | {
      /** The server rejected the token; the stored expiry hint says why. */
      status: "auth_rejected";
      error: string;
      storedExpired: boolean;
      refreshable: boolean;
    }
  /** The credential authenticated but the account is not entitled (HTTP 403). */
  | { status: "not_entitled"; error: string }
  /** HTTP 429; kept distinct so it stays eligible for stale cache fallback. */
  | { status: "rate_limited" }
  | { status: "unavailable"; error: string };

export type AgyCloudCodeRuntime = {
  credentials: AntigravityCredentialBroker;
  fetch: typeof globalThis.fetch;
};

export const defaultCloudCodeRuntime: AgyCloudCodeRuntime = {
  credentials: createAntigravityCredentialBroker(),
  fetch: (input, init) => globalThis.fetch(input, init),
};

/** The direct-read port the adapter depends on, so tests can substitute it. */
export type AgyCloudCodeSource = {
  fetchQuota(): Promise<AgyCloudCodeResult>;
  inspectCredential(): Promise<AntigravityCredentialResolution>;
};

export function createCloudCodeSource(
  runtime: AgyCloudCodeRuntime = defaultCloudCodeRuntime,
): AgyCloudCodeSource {
  return {
    fetchQuota: () => fetchCloudCodeQuotaSummary(runtime),
    inspectCredential: () => runtime.credentials.resolve(),
  };
}

export const defaultCloudCodeSource: AgyCloudCodeSource =
  createCloudCodeSource();

export async function fetchCloudCodeQuotaSummary(
  runtime: AgyCloudCodeRuntime,
): Promise<AgyCloudCodeResult> {
  const resolution = await runtime.credentials.resolve();
  switch (resolution.status) {
    case "missing":
      return { status: "credential_missing" };
    case "invalid":
      return { status: "credential_unusable", error: "invalid_credential" };
    case "unsupported":
      return {
        status: "credential_unusable",
        error: "unsupported_credential_type",
      };
    case "error":
      return {
        status: "credential_unusable",
        error: "credential_resolution_failed",
      };
  }

  // Stored expiry is advisory: probe the token rather than pre-judging it.
  const storedExpired = resolution.status === "expired";
  let response: Response;
  try {
    response = await requestQuotaSummary(resolution.credential, runtime.fetch);
  } catch (error) {
    return { status: "unavailable", error: transportError(error) };
  }

  if (response.status === 401) {
    return {
      status: "auth_rejected",
      error: storedExpired
        ? "Antigravity access token expired"
        : "Antigravity sign-in required",
      storedExpired,
      refreshable: resolution.refreshable,
    };
  }
  if (response.status === 403) {
    // 403 means the credential authenticated but the account is not licensed
    // for Antigravity, which no amount of signing in again would fix.
    return {
      status: "not_entitled",
      error: "Antigravity account is not licensed for Antigravity quota",
    };
  }
  if (response.status === 429) return { status: "rate_limited" };
  if (!response.ok) {
    return {
      status: "unavailable",
      error: `Antigravity quota endpoint returned HTTP ${response.status}`,
    };
  }

  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (error) {
    return { status: "unavailable", error: transportError(error) };
  }

  let summary: unknown;
  try {
    summary = JSON.parse(text) as unknown;
  } catch {
    return {
      status: "unavailable",
      error: "Antigravity quota endpoint returned invalid JSON",
    };
  }

  return {
    status: "quota",
    summary,
    ...(resolution.email ? { email: resolution.email } : {}),
  };
}

async function requestQuotaSummary(
  access: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(QUOTA_SUMMARY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        "User-Agent": CLOUD_CODE_USER_AGENT,
        "Client-Metadata": JSON.stringify(CLIENT_METADATA),
      },
      body: "{}",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Antigravity quota response too large");
  }
  return Buffer.from(buffer).toString("utf8");
}

function transportError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "Antigravity quota endpoint timed out";
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)) {
    return `Antigravity quota endpoint unreachable (${code})`;
  }
  return "Antigravity quota endpoint unreachable";
}
