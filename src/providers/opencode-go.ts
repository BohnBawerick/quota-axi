import { homedir } from "node:os";
import { join } from "node:path";
import { deleteCachedProvider, readCachedProvider } from "../cache.js";
import { collapseHome, readJsonFileResult } from "../lib/fs.js";
import { clampPercent, nowIso, parseEpochOrIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { VERSION } from "../version.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const API_TIMEOUT_MS = 15_000;
const USER_AGENT = `quota-axi/${VERSION}`;
const KEY_CANDIDATES = [
  "opencode-go",
  "opencode_go",
  "opencode",
  "zen",
] as const;

type OpencodeGoCredentials = {
  key: string;
  keyId: string;
  filePath: string;
};

type CredentialState =
  | {
      status: "available";
      credentials: OpencodeGoCredentials;
      source: AuthSourceReport;
    }
  | { status: "missing" | "invalid"; source: AuthSourceReport };

type OpencodeGoDependencies = {
  fetch: typeof globalThis.fetch;
  readCachedProvider: typeof readCachedProvider;
  deleteCachedProvider: typeof deleteCachedProvider;
  now: () => number;
};

const defaultDependencies: OpencodeGoDependencies = {
  fetch: globalThis.fetch,
  readCachedProvider,
  deleteCachedProvider,
  now: Date.now,
};

export function opencodeGoAuthJsonPath(): string {
  if (process.env.OPENCODE_AUTH_JSON?.trim()) {
    return process.env.OPENCODE_AUTH_JSON.trim();
  }
  if (process.env.OPENCODE_HOME?.trim()) {
    return join(process.env.OPENCODE_HOME.trim(), "auth.json");
  }
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      join(homedir(), "AppData", "Local");
    return join(base, "opencode", "auth.json");
  }
  if (process.env.XDG_DATA_HOME?.trim()) {
    return join(process.env.XDG_DATA_HOME.trim(), "opencode", "auth.json");
  }
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

export function readCredentialState(): CredentialState {
  const filePath = opencodeGoAuthJsonPath();
  const fileResult = readJsonFileResult(filePath);

  if (fileResult.status === "missing") {
    return {
      status: "missing",
      source: {
        source: "auth-json",
        path: collapseHome(filePath),
        status: "missing",
      },
    };
  }

  if (
    fileResult.status === "invalid" ||
    !fileResult.value ||
    typeof fileResult.value !== "object"
  ) {
    return {
      status: "invalid",
      source: {
        source: "auth-json",
        path: collapseHome(filePath),
        status: "invalid",
        error:
          fileResult.status === "invalid" ? fileResult.error : "invalid_json",
      },
    };
  }

  const data = fileResult.value as Record<string, unknown>;
  for (const candidateId of KEY_CANDIDATES) {
    const rawVal = data[candidateId];
    const key = extractKeyString(rawVal);
    if (key) {
      return {
        status: "available",
        credentials: {
          key,
          keyId: candidateId,
          filePath,
        },
        source: {
          source: "auth-json",
          path: collapseHome(filePath),
          status: "available",
          credentialPresent: true,
        },
      };
    }
  }

  return {
    status: "missing",
    source: {
      source: "auth-json",
      path: collapseHome(filePath),
      status: "missing",
      error: "opencode_key_not_found",
    },
  };
}

function extractKeyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const prop of ["key", "apiKey", "token", "secret"]) {
      if (typeof obj[prop] === "string" && (obj[prop] as string).trim()) {
        return (obj[prop] as string).trim();
      }
    }
  }
  return undefined;
}

export function normalizeOpencodeGoUsage(raw: unknown):
  | {
      windows: QuotaWindow[];
    }
  | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usageObj = (raw as { usage?: unknown }).usage;
  if (!usageObj || typeof usageObj !== "object") return undefined;

  const rawUsage = usageObj as Record<string, unknown>;
  const windows: QuotaWindow[] = [];

  const windowDefs: Array<{
    id: string;
    label: string;
    kind: QuotaWindow["kind"];
  }> = [
    { id: "rolling", label: "rolling", kind: "session" },
    { id: "weekly", label: "weekly", kind: "weekly" },
    { id: "monthly", label: "monthly", kind: "monthly" },
  ];

  for (const def of windowDefs) {
    const item = rawUsage[def.id];
    if (item && typeof item === "object") {
      const windowObj = item as Record<string, unknown>;
      const percentUsed =
        typeof windowObj.percent === "number"
          ? clampPercent(windowObj.percent)
          : undefined;
      const resetsAt = parseEpochOrIso(windowObj.resetsAt);

      if (percentUsed !== undefined) {
        windows.push(
          withRemaining({
            id: def.id,
            label: def.label,
            kind: def.kind,
            percentUsed,
            resetsAt,
          }),
        );
      }
    }
  }

  if (windows.length === 0) return undefined;
  return { windows };
}

export function createOpencodeGoAdapter(
  overrides: Partial<OpencodeGoDependencies> = {},
): ProviderAdapter {
  const deps = { ...defaultDependencies, ...overrides };

  return {
    id: "opencode-go",
    label: "OpenCode Go",
    fetchQuota: (options) => fetchQuotaWithDeps(options, deps),
    inspectAuth: (options) => inspectAuthWithDeps(options, deps),
  };
}

export const opencodeGoAdapter: ProviderAdapter = createOpencodeGoAdapter();

async function fetchQuotaWithDeps(
  _options: ProviderOptions,
  deps: OpencodeGoDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError: string;

  const credState = readCredentialState();
  if (credState.status === "available") {
    attempts.push({ source: "api", status: "failed" });
    try {
      const response = await fetchWithTimeout(
        USAGE_URL,
        {
          headers: {
            Authorization: `Bearer ${credState.credentials.key}`,
            "User-Agent": USER_AGENT,
          },
        },
        deps.fetch,
      );

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error("OpenCode Go sign-in required");
        }
        throw new Error(
          `OpenCode Go usage endpoint returned ${response.status}`,
        );
      }

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("invalid_json_response");
      }

      const normalized = normalizeOpencodeGoUsage(parsed);
      if (!normalized) {
        throw new Error("OpenCode Go account has no active usage windows");
      }

      attempts[attempts.length - 1] = { source: "api", status: "success" };
      deps.deleteCachedProvider("opencode-go");

      return successProvider({
        provider: "opencode-go",
        label: "OpenCode Go",
        source: "api",
        plan: "Zen Go",
        windows: normalized.windows,
        refreshedAt: nowIso(),
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      finalError = error instanceof Error ? error.message : String(error);
      attempts[attempts.length - 1] = {
        source: "api",
        status: "failed",
        error: finalError,
      };
    }
  } else {
    attempts.push({
      source: "auth-json",
      status: "skipped",
      error: `credentials_${credState.status}`,
    });
    finalError = "OpenCode Go sign-in required";
  }

  const cached = deps.readCachedProvider("opencode-go");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  const status: ProviderQuota["state"]["status"] =
    credState.status === "missing" || credState.status === "invalid"
      ? "auth_required"
      : statusFromError(finalError);

  return failedProvider({
    provider: "opencode-go",
    label: "OpenCode Go",
    status,
    error: finalError,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function inspectAuthWithDeps(
  _options: ProviderOptions,
  _deps: OpencodeGoDependencies,
): Promise<AuthProviderReport> {
  const credState = readCredentialState();
  return {
    provider: "opencode-go",
    sources: [credState.source],
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  customFetch: typeof globalThis.fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await customFetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
