import { chmodSync, renameSync, statSync, writeFileSync } from "node:fs";
import { ensurePrivateParent, readJsonFileResult } from "./fs.js";

/** Never widen a credential file beyond owner-only, whatever it was before. */
const MAX_CREDENTIAL_MODE = 0o600;

export type CredentialWriteBackOutcome =
  | { status: "written" }
  /**
   * The renewed value is still usable for this run; it simply was not
   * persisted. `source_changed` is the important one: another tool logged in
   * between our read and our write, and its newer credential must win over
   * ours rather than be clobbered.
   */
  | {
      status: "skipped";
      reason: "source_changed" | "missing" | "invalid" | "no_change";
    }
  | { status: "failed"; error: string };

/**
 * Rewrite one JSON credential file in place, preserving every key the mutation
 * did not touch.
 *
 * quota-axi does not own these files. Grok's `auth.json` holds one record per
 * `issuer::client` and Pi's holds one per provider, so a whole-file overwrite
 * would sign the user out of tools unrelated to the refresh. The mutation
 * therefore receives the parsed root and returns a new root, and the write is
 * temp + chmod + rename so a crash mid-write cannot truncate a credential the
 * user still needs.
 *
 * The file is re-read immediately before the rename and compared byte for byte
 * with what the mutation was built from. A mismatch means another writer got
 * there first, and that writer's value is newer than ours, so we skip.
 *
 * @param file absolute path to the credential file
 * @param mutate receives the parsed root; returns the root to persist, or
 *   undefined to leave the file untouched
 * @returns whether the value was persisted, and why not when it was not
 */
export function updateCredentialFile(
  file: string,
  mutate: (
    root: Record<string, unknown>,
  ) => Record<string, unknown> | undefined,
): CredentialWriteBackOutcome {
  const before = readJsonFileResult(file);
  if (before.status === "missing")
    return { status: "skipped", reason: "missing" };
  if (before.status === "invalid")
    return { status: "skipped", reason: "invalid" };

  const root = objectValue(before.value);
  if (!root) return { status: "skipped", reason: "invalid" };

  // Snapshot the exact bytes the mutation is derived from, so the pre-rename
  // comparison detects a concurrent writer even when the parse would match.
  const snapshot = JSON.stringify(before.value);

  let next: Record<string, unknown> | undefined;
  try {
    next = mutate(root);
  } catch {
    return { status: "failed", error: "credential_mutation_failed" };
  }
  if (next === undefined) return { status: "skipped", reason: "no_change" };

  const current = readJsonFileResult(file);
  if (
    current.status !== "success" ||
    JSON.stringify(current.value) !== snapshot
  ) {
    return { status: "skipped", reason: "source_changed" };
  }

  const mode = credentialMode(file);
  const temp = `${file}.quota-axi.${process.pid}.tmp`;
  try {
    ensurePrivateParent(file);
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode });
    chmodSync(temp, mode);
    renameSync(temp, file);
  } catch {
    return { status: "failed", error: "credential_write_failed" };
  }
  return { status: "written" };
}

/**
 * Keep the file's own permissions unless they are looser than owner-only, in
 * which case tighten: quota-axi has just placed a fresh secret in there and
 * must not leave it group or world readable.
 */
function credentialMode(file: string): number {
  try {
    const mode = statSync(file).mode & 0o777;
    return mode & ~MAX_CREDENTIAL_MODE ? MAX_CREDENTIAL_MODE : mode;
  } catch {
    return MAX_CREDENTIAL_MODE;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
