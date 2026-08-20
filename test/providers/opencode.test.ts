import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createOpencodeAdapter,
  opencodeAuthJsonPath,
} from "../../src/providers/opencode.js";

let tempDir: string | undefined;
const originalOpencodeAuthJson = process.env.OPENCODE_AUTH_JSON;
const originalHome = process.env.HOME;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-opencode-"));
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

describe("opencode (Zen) provider adapter", () => {
  it("resolves auth.json path correctly", () => {
    expect(opencodeAuthJsonPath()).toBe(process.env.OPENCODE_AUTH_JSON);
  });

  it("reports unmeasurable with empty windows and workspace cap warning when key is present", async () => {
    writeAuthJson({
      opencode: {
        type: "api",
        key: "test-opencode-zen-key",
      },
    });

    const adapter = createOpencodeAdapter();
    const authReport = await adapter.inspectAuth({
      allowKeychainPrompt: false,
    });
    expect(authReport.sources[0]?.status).toBe("available");

    const rawQuota = await adapter.fetchQuota({ allowKeychainPrompt: false });
    expect(rawQuota.state.status).toBe("fresh");
    expect(rawQuota.windows).toHaveLength(0);
    expect(rawQuota.plan).toBe("Zen Prepaid");

    const quota = withQuotaSemantics(rawQuota, "2026-08-20T12:00:00.000Z");
    expect(quota.quotaSemantics?.status).toBe("unknown");
    expect(quota.quotaSemantics?.effectiveAvailability).toEqual([]);
    expect(quota.quotaSemantics?.description).toContain("prepaid credit");
    expect(quota.quotaSemantics?.description).toContain(
      "workspace accounts also carry an unmeasured monthly spending cap",
    );
  });

  it("reports auth_required when key is missing", async () => {
    const adapter = createOpencodeAdapter();
    const authReport = await adapter.inspectAuth({
      allowKeychainPrompt: false,
    });
    expect(authReport.sources[0]?.status).toBe("missing");

    const quota = await adapter.fetchQuota({ allowKeychainPrompt: false });
    expect(quota.state.status).toBe("auth_required");
    expect(quota.windows).toHaveLength(0);
  });
});
