import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createOpencodeGoAdapter,
  normalizeOpencodeGoUsage,
  opencodeGoAuthJsonPath,
} from "../../src/providers/opencode-go.js";

let tempDir: string | undefined;
const originalOpencodeAuthJson = process.env.OPENCODE_AUTH_JSON;
const originalHome = process.env.HOME;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-opencode-go-"));
  process.env.OPENCODE_AUTH_JSON = join(tempDir, "auth.json");
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalOpencodeAuthJson === undefined)
    delete process.env.OPENCODE_AUTH_JSON;
  else process.env.OPENCODE_AUTH_JSON = originalOpencodeAuthJson;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function writeAuthJson(value: unknown): void {
  mkdirSync(tempDir!, { recursive: true });
  writeFileSync(process.env.OPENCODE_AUTH_JSON!, JSON.stringify(value));
}

async function withPlatform<T>(
  platform: NodeJS.Platform,
  callback: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

describe("opencode-go provider adapter", () => {
  it("resolves Windows auth.json path under LOCALAPPDATA / APPDATA", async () => {
    delete process.env.OPENCODE_AUTH_JSON;
    delete process.env.OPENCODE_HOME;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = join(
      "C:",
      "Users",
      "TestUser",
      "AppData",
      "Local",
    );
    try {
      await withPlatform("win32", async () => {
        const path = opencodeGoAuthJsonPath();
        expect(path).toBe(
          join(process.env.LOCALAPPDATA!, "opencode", "auth.json"),
        );
      });
    } finally {
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
    }
  });

  it("maps percentUsed to percentRemaining correctly", () => {
    const raw = {
      usage: {
        rolling: {
          status: "ok",
          percent: 0,
          resetsAt: "2026-08-15T15:49:05.538Z",
        },
        weekly: {
          status: "ok",
          percent: 76,
          resetsAt: "2026-08-17T00:00:00.538Z",
        },
        monthly: {
          status: "rate-limited",
          percent: 100,
          resetsAt: "2026-08-17T03:07:36.538Z",
        },
      },
    };

    const normalized = normalizeOpencodeGoUsage(raw);
    expect(normalized).toBeDefined();

    const rolling = normalized?.windows.find((w) => w.id === "rolling");
    expect(rolling?.percentUsed).toBe(0);
    expect(rolling?.percentRemaining).toBe(100);
    expect(rolling?.kind).toBe("session");

    const weekly = normalized?.windows.find((w) => w.id === "weekly");
    expect(weekly?.percentUsed).toBe(76);
    expect(weekly?.percentRemaining).toBe(24);
    expect(weekly?.kind).toBe("weekly");

    const monthly = normalized?.windows.find((w) => w.id === "monthly");
    expect(monthly?.percentUsed).toBe(100);
    expect(monthly?.percentRemaining).toBe(0);
    expect(monthly?.kind).toBe("monthly");
  });

  it("resolves key-id tolerantly (testing 'opencode' vs 'opencode-go')", async () => {
    writeAuthJson({
      opencode: {
        type: "api",
        key: "redacted-test-key-opencode",
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            usage: {
              rolling: { status: "ok", percent: 10 },
            },
          }),
        ),
    });

    const adapter = createOpencodeGoAdapter({ fetch: mockFetch as any });
    const authReport = await adapter.inspectAuth({
      allowKeychainPrompt: false,
    });
    expect(authReport.sources[0]?.status).toBe("available");

    const quota = await adapter.fetchQuota({ allowKeychainPrompt: false });
    expect(quota.state.status).toBe("fresh");
    expect(quota.windows.length).toBe(1);
    expect(quota.windows[0]?.percentRemaining).toBe(90);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer redacted-test-key-opencode",
        }),
      }),
    );
  });

  it("handles rate-limited window correctly in semantics and state", async () => {
    writeAuthJson({
      "opencode-go": {
        key: "redacted-test-key-go",
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            usage: {
              rolling: { status: "ok", percent: 50 },
              weekly: { status: "ok", percent: 80 },
              monthly: { status: "rate-limited", percent: 100 },
            },
          }),
        ),
    });

    const adapter = createOpencodeGoAdapter({ fetch: mockFetch as any });
    const rawQuota = await adapter.fetchQuota({ allowKeychainPrompt: false });
    const quota = withQuotaSemantics(rawQuota, "2026-08-15T12:00:00.000Z");

    expect(quota.state.status).toBe("fresh");
    expect(quota.quotaSemantics?.status).toBe("known");
    expect(
      quota.quotaSemantics?.effectiveAvailability[0]?.effectivePercentRemaining,
    ).toBe(0);
    expect(
      quota.quotaSemantics?.effectiveAvailability[0]?.limitingWindowIds,
    ).toEqual(["monthly"]);
    expect(quota.quotaSemantics?.description).toContain(
      "OpenCode Go is the fixed-rate subscription product (used by the Kimi CLI and Go-keyed surfaces; not the opencode CLI's prepaid Zen balance)",
    );
  });

  it("handles missing credential gracefully", async () => {
    const adapter = createOpencodeGoAdapter();
    const authReport = await adapter.inspectAuth({
      allowKeychainPrompt: false,
    });
    expect(authReport.sources[0]?.status).toBe("missing");

    const quota = await adapter.fetchQuota({ allowKeychainPrompt: false });
    expect(quota.state.status).toBe("auth_required");
    expect(quota.windows.length).toBe(0);
  });

  it("handles HTTP 401 unauthorized response", async () => {
    writeAuthJson({
      opencode: { key: "invalid-key" },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const adapter = createOpencodeGoAdapter({ fetch: mockFetch as any });
    const quota = await adapter.fetchQuota({ allowKeychainPrompt: false });
    expect(quota.state.status).toBe("auth_required");
  });
});
