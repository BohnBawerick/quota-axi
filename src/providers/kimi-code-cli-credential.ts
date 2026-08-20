import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const KIMI_CODE_CLI_CREDENTIAL_SOURCE = "kimi-code-cli";

const CREDENTIAL_FILE_LIMIT_BYTES = 64 * 1024;
const MINIMUM_FRESHNESS_SECONDS = 60;

export type KimiProviderConfig = {
  type?: string;
  apiKey?: string;
  baseUrl?: string;
};

export type KimiCliConfig = {
  defaultModel?: string;
  providers: Record<string, KimiProviderConfig>;
};

export type KimiCodeCliCredentialResolution =
  | {
      status: "available";
      accessToken: string;
      baseUrl?: string;
      providerType?: string;
      providerName?: string;
      configPath?: string;
    }
  | { status: "missing" | "invalid" | "expired" | "error" };

export type KimiCodeCliCredentialInspection =
  KimiCodeCliCredentialResolution["status"];

export type KimiCodeCliCredentialSource = {
  resolve(): Promise<KimiCodeCliCredentialResolution>;
  inspect(): Promise<KimiCodeCliCredentialInspection>;
};

type CredentialSourceDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  now: () => number;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

export function createKimiCodeCliCredentialSource(
  overrides: Partial<CredentialSourceDependencies> = {},
): KimiCodeCliCredentialSource {
  const dependencies: CredentialSourceDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    now: Date.now,
    readFile: readBoundedFile,
    ...overrides,
  };

  const inspect = async (): Promise<KimiCodeCliCredentialInspection> =>
    (await resolveCredential(dependencies)).status;

  return {
    resolve: () => resolveCredential(dependencies),
    inspect,
  };
}

async function resolveCredential(
  dependencies: CredentialSourceDependencies,
): Promise<KimiCodeCliCredentialResolution> {
  const path = credentialPath(dependencies);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, CREDENTIAL_FILE_LIMIT_BYTES);
    if (contents.byteLength > CREDENTIAL_FILE_LIMIT_BYTES) {
      return { status: "invalid" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString("utf8")) as unknown;
    } catch {
      return { status: "invalid" };
    }
    const credential = objectValue(parsed);
    const accessToken =
      typeof credential?.access_token === "string"
        ? credential.access_token.trim()
        : "";
    const expiresAt = expirySeconds(credential?.expires_at);
    if (!accessToken || expiresAt === undefined) return { status: "invalid" };
    if (expiresAt <= dependencies.now() / 1_000 + MINIMUM_FRESHNESS_SECONDS) {
      return { status: "expired" };
    }
    return { status: "available", accessToken };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return { status: "error" };
    }
  }

  // If credentials/kimi-code.json does not exist, check config.toml
  const tomlPath = configFilePath(dependencies);
  try {
    const tomlContents = await dependencies.readFile(
      tomlPath,
      CREDENTIAL_FILE_LIMIT_BYTES,
    );
    const config = parseKimiConfigToml(tomlContents.toString("utf8"));
    const selectedProviderName =
      (config.defaultModel
        ? config.defaultModel.split("/")[0]?.trim()
        : undefined) ?? Object.keys(config.providers)[0];

    const provider = selectedProviderName
      ? (config.providers[selectedProviderName] ??
        Object.values(config.providers)[0])
      : Object.values(config.providers)[0];

    if (provider && provider.apiKey?.trim()) {
      return {
        status: "available",
        accessToken: provider.apiKey.trim(),
        baseUrl: provider.baseUrl?.trim(),
        providerType: provider.type?.trim(),
        providerName: selectedProviderName,
      };
    }
    return { status: "missing" };
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "error" };
  }
}

export function parseKimiConfigToml(content: string): KimiCliConfig {
  const config: KimiCliConfig = { providers: {} };
  const lines = content.split("\n");
  let currentProvider: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const defaultModelMatch = trimmed.match(
      /^default_model\s*=\s*["']([^"']+)["']/,
    );
    if (defaultModelMatch) {
      config.defaultModel = defaultModelMatch[1];
      continue;
    }

    const providerSectionMatch = trimmed.match(
      /^\[providers\.([a-zA-Z0-9._-]+)\]$/,
    );
    if (providerSectionMatch) {
      currentProvider = providerSectionMatch[1];
      config.providers[currentProvider] ??= {};
      continue;
    }

    if (trimmed.startsWith("[") && !trimmed.startsWith("[providers.")) {
      currentProvider = undefined;
      continue;
    }

    if (currentProvider) {
      const kvMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*["']([^"']*)["']/);
      if (kvMatch) {
        const [, key, val] = kvMatch;
        const prov = config.providers[currentProvider]!;
        if (key === "api_key" || key === "apiKey") {
          prov.apiKey = val;
        } else if (key === "base_url" || key === "baseUrl") {
          prov.baseUrl = val;
        } else if (key === "type") {
          prov.type = val;
        }
      }
    }
  }

  return config;
}

function kimiHomeDirectory(dependencies: CredentialSourceDependencies): string {
  const configuredHome = nonempty(dependencies.environment.KIMI_CODE_HOME);
  return (
    configuredHome ??
    join(
      nonempty(dependencies.environment.HOME) ?? dependencies.homeDirectory(),
      ".kimi-code",
    )
  );
}

function configFilePath(dependencies: CredentialSourceDependencies): string {
  return join(kimiHomeDirectory(dependencies), "config.toml");
}

function credentialPath(dependencies: CredentialSourceDependencies): string {
  return join(kimiHomeDirectory(dependencies), "credentials", "kimi-code.json");
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

function expirySeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonempty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
