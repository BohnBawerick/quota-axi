import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateCredentialFile } from "../../src/lib/credential-writeback.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function credentialFile(contents: unknown, mode = 0o600): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-writeback-"));
  const file = join(tempDir, "auth.json");
  writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

describe("updateCredentialFile", () => {
  it("preserves every record the mutation did not touch", () => {
    const file = credentialFile({
      "https://auth.x.ai::client-a": {
        key: "old-access",
        refresh_token: "refresh-a",
        email: "someone@example.com",
        team_id: "team-1",
      },
      "some-other-provider": { type: "api_key", key: "untouched" },
    });

    const outcome = updateCredentialFile(file, (root) => {
      const record = root["https://auth.x.ai::client-a"] as Record<
        string,
        unknown
      >;
      return {
        ...root,
        "https://auth.x.ai::client-a": { ...record, key: "new-access" },
      };
    });

    expect(outcome).toEqual({ status: "written" });
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(written["https://auth.x.ai::client-a"]).toEqual({
      key: "new-access",
      refresh_token: "refresh-a",
      email: "someone@example.com",
      team_id: "team-1",
    });
    expect(written["some-other-provider"]).toEqual({
      type: "api_key",
      key: "untouched",
    });
  });

  it("keeps the file owner-only", () => {
    const file = credentialFile({ antigravity: { access: "old" } });

    updateCredentialFile(file, (root) => ({
      ...root,
      antigravity: { access: "new" },
    }));

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("tightens a world-readable credential file rather than preserving it", () => {
    const file = credentialFile({ antigravity: { access: "old" } }, 0o644);

    updateCredentialFile(file, (root) => ({
      ...root,
      antigravity: { access: "new" },
    }));

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("skips when another writer changed the file first", () => {
    const file = credentialFile({ antigravity: { access: "old" } });

    const outcome = updateCredentialFile(file, (root) => {
      // Stand in for a concurrent `agy` login landing mid-refresh.
      writeFileSync(
        file,
        `${JSON.stringify({ antigravity: { access: "newer" } })}\n`,
      );
      return { ...root, antigravity: { access: "ours" } };
    });

    expect(outcome).toEqual({ status: "skipped", reason: "source_changed" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      antigravity: { access: "newer" },
    });
  });

  it("leaves the file alone when the mutation declines", () => {
    const file = credentialFile({ antigravity: { access: "old" } });
    const before = readFileSync(file, "utf8");

    expect(updateCredentialFile(file, () => undefined)).toEqual({
      status: "skipped",
      reason: "no_change",
    });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("reports a missing file without creating one", () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-writeback-"));
    const file = join(tempDir, "absent.json");

    expect(updateCredentialFile(file, (root) => root)).toEqual({
      status: "skipped",
      reason: "missing",
    });
    expect(() => statSync(file)).toThrow();
  });

  it("refuses to rewrite an unparseable credential file", () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-writeback-"));
    const file = join(tempDir, "auth.json");
    writeFileSync(file, "{ not json", { mode: 0o600 });

    expect(updateCredentialFile(file, (root) => root)).toEqual({
      status: "skipped",
      reason: "invalid",
    });
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("reports a throwing mutation as a failure and leaves the file intact", () => {
    const file = credentialFile({ antigravity: { access: "old" } });
    const before = readFileSync(file, "utf8");

    expect(
      updateCredentialFile(file, () => {
        throw new Error("boom");
      }),
    ).toEqual({ status: "failed", error: "credential_mutation_failed" });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("leaves no temp file behind", () => {
    const file = credentialFile({ antigravity: { access: "old" } });

    updateCredentialFile(file, (root) => ({
      ...root,
      antigravity: { access: "new" },
    }));

    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(() => statSync(`${file}.quota-axi.${process.pid}.tmp`)).toThrow();
  });
});
