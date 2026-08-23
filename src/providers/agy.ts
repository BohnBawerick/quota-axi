import * as http from "node:http";
import * as https from "node:https";
import { deleteCachedProvider, readCachedProvider } from "../cache.js";
import { collapseHome } from "../lib/fs.js";
import { execFileText } from "../lib/process.js";
import {
  clampPercent,
  nowIso,
  parseEpochOrIso,
  percentRemaining,
} from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderAuthStatus,
  ProviderOptions,
  ProviderQuota,
  ProviderStateReason,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  type AgyCloudCodeSource,
  defaultCloudCodeSource,
} from "./agy-cloudcode.js";
import { piAntigravityAuthFilePath } from "./pi-antigravity-credential.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
} from "./common.js";

const QUOTA_SUMMARY_PATH =
  "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const USER_STATUS_PATH =
  "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const COMMAND_MODEL_CONFIGS_PATH =
  "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs";
const UNLEASH_PATH =
  "/exa.language_server_pb.LanguageServerService/GetUnleashData";
const PROCESS_TIMEOUT_MS = 5_000;
const PORT_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 3_000;
const PROBE_BUDGET_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type AgyProcessSource = "agy" | "app";

export type AgyProcessInfo = {
  pid: number;
  command: string;
  source: AgyProcessSource;
  csrfToken?: string;
  extensionPort?: number;
  extensionServerCsrfToken?: string;
};

export type AgyConnectionEndpoint = {
  scheme: "https" | "http";
  port: number;
  source: AgyProcessSource;
  pid: number;
  csrfToken?: string;
  requiresCsrfToken: boolean;
  requiresUnleashProbe: boolean;
};

export type AgyProbeRuntime = {
  execFileText(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<string>;
  requestJson(
    endpoint: AgyConnectionEndpoint,
    path: string,
    timeoutMs: number,
  ): Promise<unknown>;
  /**
   * Direct read of the same quota RPC from the locally stored Antigravity
   * credential, used when no local Antigravity process is discoverable.
   * Omitted by callers that exercise only the loopback path.
   */
  cloudCode?: AgyCloudCodeSource;
};

export const agyAdapter: ProviderAdapter = {
  id: "agy",
  label: "Antigravity",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  return fetchQuotaWithRuntime(defaultRuntime);
}

export async function fetchQuotaWithRuntime(
  runtime: AgyProbeRuntime,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [{ source: "loopback", status: "failed" }];
  let finalFailure: unknown;

  try {
    const quota = await fetchLoopbackQuota(runtime);
    attempts[0] = { source: "loopback", status: "success" };
    return successProvider({
      provider: "agy",
      label: "Antigravity",
      source: "cli-rpc",
      plan: quota.plan,
      account: quota.account,
      windows: quota.windows,
      refreshedAt: quota.refreshedAt,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    finalFailure = error;
    const finalError = errorMessage(error);
    attempts[0] = {
      source: "loopback",
      status: error instanceof AgyUnavailableError ? "skipped" : "failed",
      error: finalError,
    };
  }

  // Antigravity does not have to be running: the same quota RPC is readable
  // directly from the locally stored Antigravity credential.
  const direct = await fetchDirectQuota(runtime, attempts);
  if (direct.kind === "quota") return direct.quota;

  const finalError = errorMessage(finalFailure);
  if (direct.kind === "verdict") {
    if (direct.status === "auth_required") {
      try {
        deleteCachedProvider("agy");
      } catch {
        // Cache retirement is best effort; preserve the definitive verdict.
      }
    }
    return directVerdict(direct, sourceNames(attempts), attempts);
  }
  if (direct.kind === "failure") {
    finalFailure = strongerFailure(finalFailure, direct.error);
  }

  const resolvedError = errorMessage(finalFailure) || finalError;
  if (staleEligibleFailure(finalFailure)) {
    const cached = readCachedProvider("agy");
    if (cached) {
      return staleFromCache(
        cached,
        resolvedError,
        sourceNames(attempts),
        attempts,
      );
    }
  } else if (isDefinitiveAuthFailure(finalFailure)) {
    try {
      deleteCachedProvider("agy");
    } catch {
      // Cache retirement is best effort; preserve the definitive auth result.
    }
  }

  return failedProvider({
    provider: "agy",
    label: "Antigravity",
    status: statusForError(resolvedError),
    error: resolvedError,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

type AgyDirectOutcome =
  | { kind: "quota"; quota: ProviderQuota }
  | { kind: "skipped" }
  | { kind: "failure"; error: Error }
  | {
      kind: "verdict";
      status: ProviderStatus;
      error: string;
      authStatus: ProviderAuthStatus;
      reason?: ProviderStateReason;
    };

async function fetchDirectQuota(
  runtime: AgyProbeRuntime,
  attempts: SourceAttempt[],
): Promise<AgyDirectOutcome> {
  const cloudCode = runtime.cloudCode;
  if (!cloudCode) return { kind: "skipped" };

  const result = await cloudCode.fetchQuota();
  if (result.status === "credential_missing") {
    attempts.push({
      source: "auth-json",
      status: "skipped",
      error: "credentials_missing",
    });
    return { kind: "skipped" };
  }
  if (result.status === "credential_unusable") {
    attempts.push({
      source: "auth-json",
      status: "skipped",
      error: result.error,
    });
    return { kind: "skipped" };
  }

  if (result.status === "auth_rejected") {
    attempts.push({
      source: "api",
      status: "failed",
      error: result.error,
      credentialPresent: true,
    });
    // Soft expiry of a refreshable credential is not a sign-out: the quota is
    // unreadable until Antigravity's own client refreshes it.
    return result.storedExpired && result.refreshable
      ? {
          kind: "verdict",
          status: "unavailable",
          error: result.error,
          authStatus: "expired_refreshable",
          reason: "credentials_expired",
        }
      : {
          kind: "verdict",
          status: "auth_required",
          error: result.error,
          authStatus: "unusable",
        };
  }

  if (result.status === "not_entitled") {
    attempts.push({
      source: "api",
      status: "failed",
      error: result.error,
      credentialPresent: true,
    });
    // The credential itself is fine, so this is an entitlement fact, not a
    // sign-in prompt.
    return {
      kind: "verdict",
      status: "error",
      error: result.error,
      authStatus: "usable",
    };
  }

  if (result.status === "rate_limited") {
    const error = new AgyHttpError(429);
    attempts.push({ source: "api", status: "failed", error: error.message });
    return { kind: "failure", error };
  }

  if (result.status === "unavailable") {
    attempts.push({ source: "api", status: "failed", error: result.error });
    return { kind: "failure", error: new AgyUnavailableError(result.error) };
  }

  const summary = normalizeAgyQuotaSummary(result.summary);
  if (!summary) {
    const error = "Antigravity account has no active quota windows";
    attempts.push({ source: "api", status: "failed", error });
    return { kind: "failure", error: new AgyMalformedResponseError(error) };
  }

  attempts.push({ source: "api", status: "success", credentialPresent: true });
  return {
    kind: "quota",
    quota: {
      ...successProvider({
        provider: "agy",
        label: "Antigravity",
        source: "oauth",
        ...(result.email ? { account: { email: result.email } } : {}),
        windows: summary.windows,
        refreshedAt: summary.refreshedAt,
        sourcesTried: sourceNames(attempts),
        attempts,
      }),
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: summary.refreshedAt,
        authStatus: "usable",
        sourcesTried: sourceNames(attempts),
      },
    },
  };
}

function directVerdict(
  verdict: Extract<AgyDirectOutcome, { kind: "verdict" }>,
  sourcesTried: string[],
  attempts: SourceAttempt[],
): ProviderQuota {
  const failed = failedProvider({
    provider: "agy",
    label: "Antigravity",
    status: verdict.status,
    error: verdict.error,
    sourcesTried,
    attempts,
  });
  return {
    ...failed,
    state: {
      ...failed.state,
      authStatus: verdict.authStatus,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    },
  };
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  return inspectAuthWithRuntime(defaultRuntime);
}

export async function inspectAuthWithRuntime(
  runtime: AgyProbeRuntime,
): Promise<AuthProviderReport> {
  const sources: AuthSourceReport[] = [];
  try {
    const endpoints = await discoverAgyEndpoints(
      runtime,
      createProbeDeadline(),
    );
    sources.push({
      source: "loopback",
      status: endpoints.length > 0 ? "available" : "missing",
    });
  } catch (error) {
    sources.push({
      source: "loopback",
      status: "error",
      error: errorMessage(error),
    });
  }

  const credentialSource = await inspectCloudCodeCredential(runtime);
  if (credentialSource) sources.push(credentialSource);
  return { provider: "agy", sources };
}

async function inspectCloudCodeCredential(
  runtime: AgyProbeRuntime,
): Promise<AuthSourceReport | undefined> {
  const cloudCode = runtime.cloudCode;
  if (!cloudCode) return undefined;
  const resolution = await cloudCode.inspectCredential();
  // Name the store the credential actually came from, not a fixed guess.
  const path = collapseHome(resolution.path ?? piAntigravityAuthFilePath());
  switch (resolution.status) {
    case "available":
      return {
        source: "auth-json",
        path,
        status: "available",
        credentialPresent: true,
      };
    case "expired":
      return {
        source: "auth-json",
        path,
        status: "expired",
        error: "access_token_expired",
        credentialPresent: true,
      };
    case "missing":
      return { source: "auth-json", path, status: "missing" };
    case "unsupported":
      return {
        source: "auth-json",
        path,
        status: "invalid",
        error: "unsupported_credential_type",
      };
    case "invalid":
      return {
        source: "auth-json",
        path,
        status: "invalid",
        error: "invalid_credential",
      };
    default:
      return {
        source: "auth-json",
        path,
        status: "error",
        error: "credential_resolution_failed",
      };
  }
}

export function normalizeAgyQuotaSummary(raw: unknown):
  | {
      windows: QuotaWindow[];
      refreshedAt: string;
    }
  | undefined {
  const payload = quotaSummaryPayload(raw);
  const groups = arrayValue(payload?.groups);
  const windows = groups
    .flatMap(normalizeQuotaSummaryGroup)
    .sort(compareAgyWindows);
  if (windows.length === 0) return undefined;
  return { windows, refreshedAt: nowIso() };
}

export function normalizeAgyUserStatus(raw: unknown):
  | {
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
      refreshedAt: string;
    }
  | undefined {
  const data = objectValue(raw);
  const status = objectValue(data?.userStatus) ?? data;
  if (!status) return undefined;
  const planStatus = objectValue(status.planStatus);
  const planInfo = objectValue(planStatus?.planInfo);
  const accountEmail = stringValue(status.email);
  const userTier = objectValue(status.userTier);
  const plan = stringValue(userTier?.name) ?? stringValue(planInfo?.planName);
  const configData =
    objectValue(status.cascadeModelConfigData) ??
    objectValue(data?.cascadeModelConfigData) ??
    data;
  const windows = normalizeModelConfigWindows(configData);
  if (windows.length === 0 && !plan && !accountEmail) return undefined;
  return {
    plan,
    account: accountEmail ? { email: accountEmail } : undefined,
    windows,
    refreshedAt: nowIso(),
  };
}

export function processInfosFromPs(output: string): AgyProcessInfo[] {
  const processes: AgyProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2].trim();
    if (!Number.isInteger(pid) || command.length === 0) continue;
    const source = agyProcessSource(command);
    if (!source) continue;
    processes.push({
      pid,
      command,
      source,
      csrfToken: flagValue(command, "csrf_token"),
      extensionPort: numberValue(flagValue(command, "extension_server_port")),
      extensionServerCsrfToken: flagValue(
        command,
        "extension_server_csrf_token",
      ),
    });
  }
  return processes;
}

export function portsFromLsof(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/TCP\s+(?:\[[^\]]+\]|[^:]+):(\d+)\s+\(LISTEN\)/);
    const port = match ? Number(match[1]) : undefined;
    if (port && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

async function fetchLoopbackQuota(runtime: AgyProbeRuntime): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  const deadline = createProbeDeadline();
  const endpoints = await discoverAgyEndpoints(runtime, deadline);
  if (endpoints.length === 0)
    throw new AgyUnavailableError("Antigravity/agy is not running");

  let lastError: unknown;
  for (const endpoint of endpoints) {
    try {
      if (endpoint.requiresUnleashProbe)
        await probeEndpoint(runtime, endpoint, deadline);
      return await fetchEndpointQuota(runtime, endpoint, deadline);
    } catch (error) {
      lastError = strongerFailure(lastError, error);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Antigravity quota unavailable");
}

async function discoverAgyEndpoints(
  runtime: AgyProbeRuntime,
  deadline: number,
): Promise<AgyConnectionEndpoint[]> {
  const processes = processInfosFromPs(
    await readProcessList(runtime, deadline),
  );
  const endpoints: AgyConnectionEndpoint[] = [];
  let discoveryError: unknown;
  for (const processInfo of processes) {
    let listeningPorts: number[];
    try {
      listeningPorts = await readListeningPorts(
        runtime,
        processInfo.pid,
        deadline,
      );
    } catch (error) {
      if (error instanceof AgyProbeBudgetError) throw error;
      discoveryError = strongerFailure(discoveryError, error);
      continue;
    }
    if (processInfo.source === "agy") {
      for (const port of listeningPorts) {
        endpoints.push(
          endpointFor(processInfo, "https", port, undefined, false, false),
          endpointFor(processInfo, "http", port, undefined, false, false),
        );
      }
      continue;
    }

    if (processInfo.csrfToken) {
      for (const port of listeningPorts) {
        endpoints.push(
          endpointFor(
            processInfo,
            "https",
            port,
            processInfo.csrfToken,
            true,
            true,
          ),
          endpointFor(
            processInfo,
            "http",
            port,
            processInfo.csrfToken,
            true,
            true,
          ),
        );
      }
    }

    if (
      processInfo.extensionPort &&
      listeningPorts.includes(processInfo.extensionPort)
    ) {
      const token =
        processInfo.extensionServerCsrfToken ?? processInfo.csrfToken;
      if (token) {
        endpoints.push(
          endpointFor(
            processInfo,
            "http",
            processInfo.extensionPort,
            token,
            true,
            true,
          ),
        );
      }
    }
  }
  if (endpoints.length === 0 && discoveryError) throw discoveryError;
  return endpoints.sort(compareEndpoints);
}

function endpointFor(
  processInfo: AgyProcessInfo,
  scheme: AgyConnectionEndpoint["scheme"],
  port: number,
  csrfToken: string | undefined,
  requiresCsrfToken: boolean,
  requiresUnleashProbe: boolean,
): AgyConnectionEndpoint {
  return {
    scheme,
    port,
    source: processInfo.source,
    pid: processInfo.pid,
    csrfToken,
    requiresCsrfToken,
    requiresUnleashProbe,
  };
}

async function fetchEndpointQuota(
  runtime: AgyProbeRuntime,
  endpoint: AgyConnectionEndpoint,
  deadline: number,
): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  let summaryError: unknown;
  try {
    const summary = normalizeAgyQuotaSummary(
      await withinProbeBudget(deadline, REQUEST_TIMEOUT_MS, (timeoutMs) =>
        runtime.requestJson(endpoint, QUOTA_SUMMARY_PATH, timeoutMs),
      ),
    );
    if (summary) {
      const identity = await fetchEndpointIdentity(runtime, endpoint, deadline);
      return {
        ...summary,
        plan: identity?.plan,
        account: identity?.account,
      };
    }
    summaryError = new AgyMalformedResponseError(
      "Antigravity quota summary malformed",
    );
  } catch (error) {
    summaryError = strongerFailure(summaryError, error);
  }

  for (const path of [USER_STATUS_PATH, COMMAND_MODEL_CONFIGS_PATH]) {
    try {
      const fallback = normalizeAgyUserStatus(
        await withinProbeBudget(deadline, REQUEST_TIMEOUT_MS, (timeoutMs) =>
          runtime.requestJson(endpoint, path, timeoutMs),
        ),
      );
      if (fallback && fallback.windows.length > 0) return fallback;
    } catch (error) {
      summaryError = strongerFailure(summaryError, error);
    }
  }

  throw summaryError instanceof Error
    ? summaryError
    : new Error("Antigravity quota unavailable");
}

async function probeEndpoint(
  runtime: AgyProbeRuntime,
  endpoint: AgyConnectionEndpoint,
  deadline: number,
): Promise<void> {
  await withinProbeBudget(deadline, REQUEST_TIMEOUT_MS, (timeoutMs) =>
    runtime.requestJson(endpoint, UNLEASH_PATH, timeoutMs),
  );
}

async function fetchEndpointIdentity(
  runtime: AgyProbeRuntime,
  endpoint: AgyConnectionEndpoint,
  deadline: number,
): Promise<
  | {
      plan?: string;
      account?: ProviderQuota["account"];
    }
  | undefined
> {
  try {
    return normalizeAgyUserStatus(
      await withinProbeBudget(deadline, REQUEST_TIMEOUT_MS, (timeoutMs) =>
        runtime.requestJson(endpoint, USER_STATUS_PATH, timeoutMs),
      ),
    );
  } catch {
    return undefined;
  }
}

async function readProcessList(
  runtime: AgyProbeRuntime,
  deadline: number,
): Promise<string> {
  if (process.platform === "win32") return "";
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined)
    throw new AgyDiscoveryError("Antigravity process discovery failed");
  // procps-ng rejects the BSD `-x` flag ("must set personality to get -x
  // option"), so fall back to the same selection without it before giving up.
  const argumentSets = [
    ["-x", "-u", String(effectiveUid), "-o", "pid=,command="],
    ["-u", String(effectiveUid), "-o", "pid=,command="],
  ];
  for (const [index, args] of argumentSets.entries()) {
    try {
      return await withinProbeBudget(
        deadline,
        PROCESS_TIMEOUT_MS,
        (timeoutMs) => runtime.execFileText("ps", args, timeoutMs),
      );
    } catch (error) {
      if (error instanceof AgyProbeBudgetError) throw error;
      if (index === argumentSets.length - 1)
        throw new AgyDiscoveryError("Antigravity process discovery failed");
    }
  }
  throw new AgyDiscoveryError("Antigravity process discovery failed");
}

async function readListeningPorts(
  runtime: AgyProbeRuntime,
  pid: number,
  deadline: number,
): Promise<number[]> {
  if (process.platform === "win32") return [];
  try {
    return portsFromLsof(
      await withinProbeBudget(deadline, PORT_TIMEOUT_MS, (timeoutMs) =>
        runtime.execFileText(
          "lsof",
          ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"],
          timeoutMs,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof AgyProbeBudgetError) throw error;
    throw new AgyDiscoveryError("Antigravity port discovery failed");
  }
}

function normalizeQuotaSummaryGroup(raw: unknown): QuotaWindow[] {
  const group = objectValue(raw);
  if (!group) return [];
  const groupName = stringValue(group.displayName) ?? "Quota";
  return arrayValue(group.buckets)
    .map((bucket) => normalizeQuotaSummaryBucket(groupName, bucket))
    .filter((window): window is QuotaWindow => Boolean(window));
}

function normalizeQuotaSummaryBucket(
  groupName: string,
  raw: unknown,
): QuotaWindow | undefined {
  const bucket = objectValue(raw);
  if (!bucket) return undefined;
  const disabled = booleanValue(bucket.disabled) ?? false;
  if (disabled) return undefined;
  const bucketId =
    stringValue(bucket.bucketId) ?? stringValue(bucket.bucket_id);
  if (!bucketId) return undefined;
  const windowKind = agyWindowKind(bucket);
  const group = agyWindowGroup(groupName, bucketId);
  const label = `${group.label} ${windowKind.label}`;
  const result: QuotaWindow = {
    id: `${group.id}_${windowKind.id}`,
    label,
    kind: windowKind.kind,
    resetsAt:
      parseEpochOrIso(bucket.resetTime) ?? parseEpochOrIso(bucket.reset_time),
    resetText: stringValue(bucket.description),
  };
  const remaining = remainingFraction(bucket);
  if (remaining !== undefined) {
    const percentUsed = clampPercent((1 - clampFraction(remaining)) * 100);
    result.percentUsed = percentUsed;
    result.percentRemaining = percentRemaining(percentUsed);
  }
  if (result.percentUsed === undefined && !result.resetsAt && !result.resetText)
    return undefined;
  return result;
}

function normalizeModelConfigWindows(raw: unknown): QuotaWindow[] {
  const data = objectValue(raw);
  const configs = arrayValue(data?.clientModelConfigs);
  return configs
    .map(normalizeModelConfigWindow)
    .filter((window): window is QuotaWindow => Boolean(window));
}

function normalizeModelConfigWindow(raw: unknown): QuotaWindow | undefined {
  const config = objectValue(raw);
  if (!config) return undefined;
  const label = stringValue(config.label);
  const quotaInfo = objectValue(config.quotaInfo);
  const modelOrAlias = objectValue(config.modelOrAlias);
  const modelId =
    stringValue(modelOrAlias?.model) ??
    stringValue(modelOrAlias?.alias) ??
    (label ? slugify(label) : undefined);
  if (!label || !modelId || !quotaInfo) return undefined;
  const remaining = remainingFraction(quotaInfo);
  const result: QuotaWindow = {
    id: `model:${slugify(modelId)}`,
    label,
    kind: "model",
    resetsAt:
      parseEpochOrIso(quotaInfo.resetTime) ??
      parseEpochOrIso(quotaInfo.reset_time),
  };
  if (remaining !== undefined) {
    const percentUsed = clampPercent((1 - clampFraction(remaining)) * 100);
    result.percentUsed = percentUsed;
    result.percentRemaining = percentRemaining(percentUsed);
  }
  return result.percentUsed === undefined && !result.resetsAt
    ? undefined
    : result;
}

function quotaSummaryPayload(
  raw: unknown,
): Record<string, unknown> | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  return (
    objectValue(data.response) ??
    objectValue(data.summary) ??
    (Array.isArray(data.groups) ? data : undefined)
  );
}

function agyWindowGroup(
  groupName: string,
  bucketId: string,
): { id: string; label: string; sortRank: number } {
  const normalized = `${groupName} ${bucketId}`.toLowerCase();
  if (normalized.includes("gemini")) {
    return { id: "gemini", label: "Gemini", sortRank: 0 };
  }
  if (
    normalized.includes("claude") ||
    normalized.includes("gpt") ||
    normalized.includes("3p")
  ) {
    return { id: "claude_gpt", label: "Claude/GPT", sortRank: 1 };
  }
  const id = slugify(groupName) || "quota";
  return { id, label: groupName, sortRank: 2 };
}

function agyWindowKind(bucket: Record<string, unknown>): {
  id: "5h" | "weekly" | "unknown";
  label: "5-hour" | "weekly" | "quota";
  kind: QuotaWindow["kind"];
  sortRank: number;
} {
  const raw = [
    stringValue(bucket.window),
    stringValue(bucket.bucketId),
    stringValue(bucket.bucket_id),
    stringValue(bucket.displayName),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  if (raw.includes("5h") || raw.includes("five")) {
    return {
      id: "5h",
      label: "5-hour",
      kind: "session",
      sortRank: 0,
    };
  }
  if (raw.includes("week")) {
    return {
      id: "weekly",
      label: "weekly",
      kind: "weekly",
      sortRank: 1,
    };
  }
  return { id: "unknown", label: "quota", kind: "unknown", sortRank: 2 };
}

function remainingFraction(data: Record<string, unknown>): number | undefined {
  return (
    numberValue(data.remainingFraction) ??
    numberValue(data.remaining_fraction) ??
    oneofRemainingFraction(data.remaining)
  );
}

function oneofRemainingFraction(raw: unknown): number | undefined {
  const direct = numberValue(raw);
  if (direct !== undefined) return direct;
  const data = objectValue(raw);
  if (!data) return undefined;
  return (
    numberValue(data.remainingFraction) ??
    numberValue(data.remaining_fraction) ??
    (stringValue(data.case) === "remainingFraction" ||
    stringValue(data.case) === "remaining_fraction"
      ? numberValue(data.value)
      : undefined)
  );
}

function compareAgyWindows(left: QuotaWindow, right: QuotaWindow): number {
  const leftGroup = windowGroupRank(left.id);
  const rightGroup = windowGroupRank(right.id);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  return windowKindRank(left) - windowKindRank(right);
}

function windowGroupRank(id: string): number {
  if (id.startsWith("gemini_")) return 0;
  if (id.startsWith("claude_gpt_")) return 1;
  return 2;
}

function windowKindRank(window: QuotaWindow): number {
  if (window.kind === "session") return 0;
  if (window.kind === "weekly") return 1;
  return 2;
}

function agyProcessSource(command: string): AgyProcessSource | undefined {
  const commandTokens = tokenizeCommand(command);
  const invokedExecutable = executableName(commandTokens[0] ?? "");
  if (invokedExecutable === "agy") return "agy";

  if (
    invokedExecutable &&
    /^(?:node|nodejs|bun|mcp-server(?:\.cjs)?)$/.test(invokedExecutable)
  ) {
    const script = invokedExecutable.startsWith("mcp-server")
      ? commandTokens[0]
      : commandTokens[1];
    if (isAgyMcpScript(script)) return "agy";
  }

  if (isAgyAppExecutable(command)) return "app";
  return undefined;
}

function tokenizeCommand(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
}

function isAgyMcpScript(token: string | undefined): boolean {
  if (!token) return false;
  const path = normalizedPath(token);
  return (
    path.split("/").pop() === "mcp-server.cjs" &&
    path.split("/").includes("antigravity-cli")
  );
}

function isAgyAppExecutable(command: string): boolean {
  const normalized = normalizedPath(command);
  if (
    /^\/applications\/[^\n]*antigravity\.app\/contents\/[^\n]*\/language[-_]server(?:_[a-z0-9_]+)?(?=\s+--|$)/.test(
      normalized,
    )
  )
    return true;
  const firstToken = tokenizeCommand(command)[0];
  if (!firstToken) return false;
  const path = normalizedPath(firstToken);
  return (
    path.includes("antigravity") &&
    /(?:^|\/)language[-_]server(?:_[a-z0-9_]+)?(?:\.exe)?$/.test(path)
  );
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function executableName(command: string): string | undefined {
  const token = command.trim().split(/\s+/, 1)[0];
  if (!token) return undefined;
  const name = token.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  return name?.replace(/\.exe$/, "");
}

function flagValue(command: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)--${name}(?:=([^\\s]+)|\\s+([^\\s]+))`);
  const match = command.match(pattern);
  return match?.[1] ?? match?.[2];
}

function portsFromEndpoint(endpoint: AgyConnectionEndpoint): number {
  return endpoint.port;
}

function compareEndpoints(
  left: AgyConnectionEndpoint,
  right: AgyConnectionEndpoint,
): number {
  const sourceRank = sourceSortRank(left.source) - sourceSortRank(right.source);
  if (sourceRank !== 0) return sourceRank;
  const portRank = portsFromEndpoint(left) - portsFromEndpoint(right);
  if (portRank !== 0) return portRank;
  return schemeSortRank(left.scheme) - schemeSortRank(right.scheme);
}

function sourceSortRank(source: AgyProcessSource): number {
  return source === "agy" ? 0 : 1;
}

function schemeSortRank(scheme: AgyConnectionEndpoint["scheme"]): number {
  return scheme === "https" ? 0 : 1;
}

function statusForError(error: string): ProviderStatus {
  if (
    /not running|no local|loopback unavailable|(?:loopback|probe) timed out|ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EPIPE|EPROTO|socket hang up/i.test(
      error,
    )
  )
    return "unavailable";
  return statusFromError(error);
}

export function requestLoopbackJson(
  endpoint: AgyConnectionEndpoint,
  path: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(requestBodyForPath(path));
    const headers: Record<string, string | number> = {
      accept: "application/json",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "connect-protocol-version": "1",
    };
    if (endpoint.requiresCsrfToken && endpoint.csrfToken) {
      headers["x-codeium-csrf-token"] = endpoint.csrfToken;
    }
    const options: http.RequestOptions & https.RequestOptions = {
      hostname: "127.0.0.1",
      port: endpoint.port,
      path,
      method: "POST",
      headers,
    };
    if (endpoint.scheme === "https") options.rejectUnauthorized = false;
    const client = endpoint.scheme === "https" ? https : http;
    let response: http.IncomingMessage | undefined;
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        response?.destroy();
        request.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const request = client.request(options, (incoming) => {
      response = incoming;
      if (
        !incoming.statusCode ||
        incoming.statusCode < 200 ||
        incoming.statusCode >= 300
      ) {
        finish(new AgyHttpError(incoming.statusCode ?? 0));
        return;
      }
      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;
      incoming.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        receivedBytes += bytes.byteLength;
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          finish(
            new AgyMalformedResponseError(
              "Antigravity loopback response too large",
            ),
          );
          return;
        }
        chunks.push(new Uint8Array(bytes));
      });
      incoming.on("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          finish(undefined, JSON.parse(text) as unknown);
        } catch {
          finish(
            new AgyMalformedResponseError(
              "Antigravity loopback returned invalid JSON",
            ),
          );
        }
      });
      incoming.on("error", (error) => finish(sanitizeTransportError(error)));
    });
    const timer = setTimeout(
      () => finish(new AgyUnavailableError("Antigravity loopback timed out")),
      timeoutMs,
    );
    request.on("error", (error) => finish(sanitizeTransportError(error)));
    request.end(body);
  });
}

function requestBodyForPath(path: string): Record<string, unknown> {
  if (path === QUOTA_SUMMARY_PATH) return { forceRefresh: false };
  return {
    metadata: {
      ideName: "antigravity",
      extensionName: "antigravity",
      ideVersion: "unknown",
      locale: "en",
    },
  };
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Antigravity quota unavailable";
}

function sanitizeTransportError(error: Error): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && /^[A-Z][A-Z0-9_]+$/.test(code)) {
    return new AgyUnavailableError(
      `Antigravity loopback unavailable (${code})`,
    );
  }
  return new AgyUnavailableError("Antigravity loopback unavailable");
}

function strongerFailure(current: unknown, candidate: unknown): unknown {
  if (current === undefined) return candidate;
  return failureRank(candidate) > failureRank(current) ? candidate : current;
}

function failureRank(error: unknown): number {
  const status = statusForError(errorMessage(error));
  if (status === "auth_required") return 4;
  if (status === "rate_limited") return 3;
  if (status === "error") return 2;
  if (status === "unavailable") return 1;
  return 0;
}

function staleEligibleFailure(error: unknown): boolean {
  if (error instanceof AgyHttpError)
    return error.status === 429 || error.status >= 500;
  return statusForError(errorMessage(error)) === "unavailable";
}

function isDefinitiveAuthFailure(error: unknown): boolean {
  return statusForError(errorMessage(error)) === "auth_required";
}

function createProbeDeadline(): number {
  return Date.now() + PROBE_BUDGET_MS;
}

function withinProbeBudget<T>(
  deadline: number,
  perOperationTimeoutMs: number,
  operation: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0)
    return Promise.reject(
      new AgyProbeBudgetError("Antigravity probe timed out"),
    );
  const timeoutMs = Math.min(perOperationTimeoutMs, remainingMs);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AgyProbeBudgetError("Antigravity probe timed out")),
      timeoutMs,
    );
    operation(timeoutMs).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class AgyUnavailableError extends Error {}

class AgyProbeBudgetError extends AgyUnavailableError {}

class AgyMalformedResponseError extends Error {}

class AgyDiscoveryError extends Error {}

class AgyHttpError extends Error {
  constructor(readonly status: number) {
    super(httpErrorMessage(status));
  }
}

function httpErrorMessage(status: number): string {
  if (status === 401 || status === 403) return "Antigravity sign-in required";
  if (status === 429) return "Antigravity quota endpoint rate limited";
  return `Antigravity quota endpoint returned HTTP ${status}`;
}

const defaultRuntime: AgyProbeRuntime = {
  execFileText,
  requestJson: requestLoopbackJson,
  cloudCode: defaultCloudCodeSource,
};
