/**
 * Every role model write the omo tab and `ocx agent roles set` make, so a role can be put back.
 * The integration journal cannot hold these: it snapshots one client config per operation, and a
 * role write spans `$CODEX_HOME/agents/<role>.toml` and LazyCodex's omo.jsonc mirror. So the
 * values are recorded rather than bytes, and a restore is an ordinary write of the earlier values.
 * Writes made in one action (auto-assign's Apply all) share a batch and are restored together.
 * The file sits under the opencodex config directory, which outlives a switch of Codex home, so every
 * row names the canonical Codex home it was written in and only that home's rows are listed or restored.
 * The file is bounded three ways: a batch holds at most ROLE_HISTORY_LIMIT rows, an append that takes
 * the file past ROLE_HISTORY_MAX_BYTES rewrites it to its newest whole batches, and a read looks at
 * no more than that many bytes and ROLE_HISTORY_MAX_ROWS rows from the end.
 */
import { appendFileSync, closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { ensureDir, integrationsDir } from "../integrations/ownership";

export interface RoleSetting {
  readonly model: string | null;
  readonly effort: string | null;
}

export interface RoleModelChange {
  readonly at: string;
  readonly batch: string;
  readonly role: string;
  readonly before: RoleSetting;
  readonly after: RoleSetting;
}

interface StoredRoleModelChange extends RoleModelChange {
  readonly codexHome: string;
}

/** Rows one listing returns, and rows one batch may hold, so a whole batch always fits a listing. */
export const ROLE_HISTORY_LIMIT = 50;
export const ROLE_HISTORY_MAX_BYTES = 256 * 1024;
export const ROLE_HISTORY_MAX_ROWS = 1000;
const BATCH_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function historyPath(dir: string): string {
  return join(dir, "codex-agent-roles.jsonl");
}

export function isRoleHistoryBatch(value: unknown): value is string {
  return typeof value === "string" && BATCH_PATTERN.test(value);
}

/** `codexHome` is the canonical path `getCodexHome()` returns, so two spellings of one home match. */
export function recordRoleModelChange(codexHome: string, change: RoleModelChange, dir: string = integrationsDir()): void {
  ensureDir(historyPath(dir));
  const stored: StoredRoleModelChange = { ...change, codexHome };
  appendFileSync(historyPath(dir), `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
  if (statSync(historyPath(dir)).size <= ROLE_HISTORY_MAX_BYTES) return;
  try {
    compact(dir);
  } catch (cause) {
    // Reads stay bounded without the trim; the next append retries it.
    throw new Error("recorded the change but could not trim the history file", { cause });
  }
}

/**
 * Rewrite the file to its newest rows within half the byte budget and the row budget, so the next
 * compaction is many saves away. A batch the cut falls inside is dropped whole, for every Codex home,
 * so no home is left with part of an Apply all to restore.
 */
function compact(dir: string): void {
  const rows = tailRows(historyPath(dir));
  const kept: StoredRoleModelChange[] = [];
  let bytes = 0;
  for (const row of rows) {
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes > ROLE_HISTORY_MAX_BYTES / 2 || kept.length >= ROLE_HISTORY_MAX_ROWS) break;
    kept.push(row);
  }
  const cut = new Set(rows.slice(kept.length).map(batchKey));
  const whole = kept.filter(row => !cut.has(batchKey(row))).reverse();
  atomicWriteFile(historyPath(dir), whole.map(row => `${JSON.stringify(row)}\n`).join(""));
}

function batchKey(row: StoredRoleModelChange): string {
  return `${row.codexHome}\n${row.batch}`;
}

function isSetting(value: unknown): value is RoleSetting {
  const setting = value as RoleSetting | null;
  return typeof setting === "object" && setting !== null
    && (setting.model === null || typeof setting.model === "string")
    && (setting.effort === null || typeof setting.effort === "string");
}

function parseRow(line: string): StoredRoleModelChange | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const change = value as StoredRoleModelChange | null;
  return typeof change === "object" && change !== null && typeof change.codexHome === "string"
    && typeof change.at === "string" && typeof change.role === "string"
    && isRoleHistoryBatch(change.batch) && isSetting(change.before) && isSetting(change.after)
    ? change
    : null;
}

/**
 * Every Codex home's rows, newest first, from at most the last ROLE_HISTORY_MAX_BYTES of the file and
 * at most ROLE_HISTORY_MAX_ROWS of them. When the read starts mid-file, its first partial line is
 * skipped and so is the batch of its oldest row, which may continue above the read.
 */
function tailRows(path: string): StoredRoleModelChange[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let text: string;
  let truncated: boolean;
  try {
    const stat = fstatSync(fd);
    // Windows opens a directory for reading, so the type is checked rather than left to the read.
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    const size = stat.size;
    const start = Math.max(0, size - ROLE_HISTORY_MAX_BYTES - 1);
    const bytes = Buffer.alloc(size - start);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, start + length);
      if (count === 0) break;
      length += count;
    }
    truncated = start > 0;
    const read = bytes.subarray(0, length);
    text = (truncated ? read.subarray(read.indexOf(10) + 1) : read).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n").filter(line => line.trim());
  truncated ||= lines.length > ROLE_HISTORY_MAX_ROWS;
  const rows = lines.slice(-ROLE_HISTORY_MAX_ROWS).flatMap(line => {
    const row = parseRow(line);
    return row ? [row] : [];
  }).reverse();
  const partial = truncated ? rows.at(-1) : undefined;
  return partial ? rows.filter(row => batchKey(row) !== batchKey(partial)) : rows;
}

function forHome(rows: StoredRoleModelChange[], codexHome: string): RoleModelChange[] {
  return rows.flatMap(({ codexHome: home, ...change }) => home === codexHome ? [change] : []);
}

/**
 * This Codex home's changes, newest first, in whole batches and never more than `limit` rows: batches
 * are taken newest first until the next would not fit, so Restore never puts back part of an Apply all.
 * A batch larger than `limit` (written before batches were capped) can never be listed whole and is
 * skipped. A torn or foreign line, and a row another Codex home wrote, is skipped, the way the
 * integration journal reads its own.
 */
export function listRoleModelChanges(codexHome: string, limit: number = ROLE_HISTORY_LIMIT, dir: string = integrationsDir()): RoleModelChange[] {
  const newestFirst = forHome(tailRows(historyPath(dir)), codexHome);
  const sizes = new Map<string, number>();
  for (const change of newestFirst) sizes.set(change.batch, (sizes.get(change.batch) ?? 0) + 1);
  const listed = new Set<string>();
  let count = 0;
  for (const [batch, size] of sizes) {
    if (size > limit) continue;
    if (count + size > limit) break;
    listed.add(batch);
    count += size;
  }
  return newestFirst.filter(change => listed.has(change.batch));
}

/** How many rows this Codex home's history holds in `batch`; a write is refused once it reaches the cap. */
export function roleHistoryBatchSize(codexHome: string, batch: string, dir: string = integrationsDir()): number {
  return forHome(tailRows(historyPath(dir)), codexHome).filter(change => change.batch === batch).length;
}

/**
 * The setting a Restore of `batch` may put back on `role` in this Codex home: the role's earliest
 * `before` in that batch, or null when this home's listed history has no such change. The server
 * checks a restore against it, so a dashboard still showing another home's history cannot write
 * that home's earlier models here.
 */
export function restorableSetting(codexHome: string, batch: string, role: string, dir: string = integrationsDir()): RoleSetting | null {
  const changes = listRoleModelChanges(codexHome, ROLE_HISTORY_LIMIT, dir).filter(change => change.batch === batch && change.role === role);
  return changes.at(-1)?.before ?? null;
}
