import { homedir } from "node:os";
import { join } from "node:path";
import { deleteCachedProvider, readCachedProvider } from "../cache.js";
import { collapseHome, readJsonFileResult } from "../lib/fs.js";
import { nowIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

const KEY_CANDIDATES = [
  "opencode",
  "zen",
  "opencode_zen",
  "opencode-zen",
] as const;

type OpencodeCredentials = {
  key: string;
  keyId: string;
  filePath: string;
};

type CredentialState =
  | {
      status: "available";
      credentials: OpencodeCredentials;
      source: AuthSourceReport;
    }
  | { status: "missing" | "invalid"; source: AuthSourceReport };

type OpencodeDependencies = {
  readCachedProvider: typeof readCachedProvider;
  deleteCachedProvider: typeof deleteCachedProvider;
  now: () => number;
};

const defaultDependencies: OpencodeDependencies = {
  readCachedProvider,
  deleteCachedProvider,
  now: Date.now,
};

export function opencodeAuthJsonPath(): string {
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

export function readOpencodeCredentialState(): CredentialState {
  const filePath = opencodeAuthJsonPath();
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

export function createOpencodeAdapter(
  overrides: Partial<OpencodeDependencies> = {},
): ProviderAdapter {
  const deps = { ...defaultDependencies, ...overrides };

  return {
    id: "opencode",
    label: "OpenCode",
    fetchQuota: (options) => fetchQuotaWithDeps(options, deps),
    inspectAuth: (options) => inspectAuthWithDeps(options, deps),
  };
}

export const opencodeAdapter: ProviderAdapter = createOpencodeAdapter();

async function fetchQuotaWithDeps(
  _options: ProviderOptions,
  _deps: OpencodeDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  const credState = readOpencodeCredentialState();

  if (credState.status === "available") {
    attempts.push({ source: "auth-json", status: "success" });
    return successProvider({
      provider: "opencode",
      label: "OpenCode",
      source: "api",
      plan: "Zen Prepaid",
      windows: [],
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  attempts.push({
    source: "auth-json",
    status: "skipped",
    error: `credentials_${credState.status}`,
  });

  return failedProvider({
    provider: "opencode",
    label: "OpenCode",
    status: "auth_required",
    error: "OpenCode sign-in required",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function inspectAuthWithDeps(
  _options: ProviderOptions,
  _deps: OpencodeDependencies,
): Promise<AuthProviderReport> {
  const credState = readOpencodeCredentialState();
  return {
    provider: "opencode",
    sources: [credState.source],
  };
}
