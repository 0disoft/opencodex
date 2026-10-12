/**
 * Cooperative ingest of canonical `usage.jsonl` rows into a request-history
 * index generation (#6990).
 *
 * `ingestSteps` is a generator that yields after every read chunk, so a
 * caller bounds how long one call runs on the serving event loop. Rows,
 * `indexed_offset` and `indexed_rows` commit in the same transaction, so an
 * ingest that stops between batches resumes at the last committed line.
 */

import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import {
  encodePersistedRequestedModel,
  type PersistedUsageEntry,
  type UsageLogRevision,
} from "../../usage/log";
import { HISTORY_META_KEYS } from "./schema";

export const REQUEST_HISTORY_INSERT_BATCH = 500;
// Rows may be up to REQUEST_HISTORY_MAX_RECORD_BYTES each, so a row count alone
// does not bound one transaction; a batch also commits before its source bytes
// pass this cap, keeping each synchronous COMMIT to a few milliseconds.
export const REQUEST_HISTORY_INSERT_BATCH_BYTES = 4 * 1024 * 1024;
// A staged batch drains in sub-transactions sized from the measured cost of
// the previous one, so a slow disk or a large index shrinks each synchronous
// transaction instead of stretching one step (Windows: 500 rows took 20-60 ms).
export const REQUEST_HISTORY_COMMIT_TARGET_MS = 8;
export const REQUEST_HISTORY_MIN_COMMIT_ROWS = 16;
export const REQUEST_HISTORY_INITIAL_COMMIT_ROWS = 64;
export const REQUEST_HISTORY_READ_CHUNK_BYTES = 64 * 1024;
// The SQLite index is a disposable projection. Complete JSONL records above
// this bound are omitted from the projection; the canonical usage.jsonl is
// never truncated or rewritten by the indexer.
export const REQUEST_HISTORY_MAX_RECORD_BYTES = 1024 * 1024;
// A commit that keeps meeting another connection's write lock gives up after
// this many yields; the refresh fails as transient and the next one retries.
const BUSY_COMMIT_RETRIES = 40;

/**
 * The ledger or the index generation changed under a suspended refresh. The
 * refresh restarts against fresh state; it never rebuilds because of this.
 */
export class RequestHistoryIndexStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestHistoryIndexStaleError";
  }
}

function sqliteCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

export function isSqliteBusy(error: unknown): boolean {
  const code = sqliteCode(error);
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}

export function isSqliteCorruption(error: unknown): boolean {
  const code = sqliteCode(error);
  if (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB") return true;
  const message = error instanceof Error ? error.message : "";
  return /database disk image is malformed|file is not a database/i.test(message);
}

type Row = Array<string | number | null>;

/** A parsed row with the byte offset just past its line, so any prefix commits an exact resume point. */
interface PendingRow {
  values: Row;
  endOffset: number;
  sourceBytes: number;
}

/**
 * Rows for the next sub-transaction after one that attempted `attemptedRows`
 * (duplicates included) in `elapsedMs`: aim at the target, shrink at once,
 * grow at most twofold, and stay within [MIN_COMMIT_ROWS, INSERT_BATCH].
 */
export function nextCommitRowLimit(current: number, attemptedRows: number, elapsedMs: number): number {
  if (attemptedRows <= 0) return current;
  const estimate = elapsedMs > 0
    ? Math.floor((REQUEST_HISTORY_COMMIT_TARGET_MS * attemptedRows) / elapsedMs)
    : REQUEST_HISTORY_INSERT_BATCH;
  const next = Math.min(estimate, current * 2);
  return Math.max(REQUEST_HISTORY_MIN_COMMIT_ROWS, Math.min(REQUEST_HISTORY_INSERT_BATCH, next));
}

export function metaValue(dbHandle: Database, key: string): string | null {
  const row = dbHandle.query("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(dbHandle: Database, key: string, value: string | number): void {
  dbHandle.query(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

export function metaNumber(dbHandle: Database, key: string): number {
  const value = metaValue(dbHandle, key);
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Extract the `requests` row columns from a canonical persisted entry. */
function extractRow(entry: PersistedUsageEntry): Row {
  const attempts = entry.attempts;
  return [
    entry.requestId,
    entry.timestamp,
    entry.provider,
    entry.model,
    // Old canonical JSONL rows can predate bounded selector persistence. Encode
    // the disposable projection on rebuild so exact filters match across versions.
    typeof entry.requestedModel === "string" ? encodePersistedRequestedModel(entry.requestedModel) : null,
    entry.status,
    entry.surface ?? null,
    entry.inboundProtocol ?? null,
    entry.apiKeyId ?? null,
    entry.conversationId ?? null,
    entry.routeDecision?.routeKind ?? null,
    entry.routeDecision?.profile?.id ?? null,
    entry.routeDecision?.profile?.revision ?? null,
    (attempts?.length ?? 0) > 1 ? 1 : 0,
    entry.durationMs,
    entry.firstOutputMs ?? null,
    entry.usageStatus,
    entry.usage ? JSON.stringify(entry.usage) : null,
    entry.totalTokens ?? null,
    entry.errorCode ?? null,
    entry.terminalStatus ?? null,
    entry.closeReason ?? null,
    attempts?.length ?? 1,
    entry.routeDecision ? JSON.stringify(entry.routeDecision) : null,
    JSON.stringify(entry),
  ];
}

const ROW_INSERT = `
INSERT OR IGNORE INTO requests (
  request_id, timestamp, provider, model, requested_model, status, surface,
  inbound_protocol, api_key_id, conversation_id, route_kind, profile_id,
  profile_revision, fallback, duration_ms, first_output_ms, usage_status,
  usage_json, total_tokens, error_code, terminal_status, close_reason,
  attempt_count, decision_json, row_json
) VALUES (
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?
)`;

function parsedEntryFromLine(line: string): PersistedUsageEntry | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as PersistedUsageEntry;
    if (parsed && typeof parsed === "object"
      && typeof parsed.requestId === "string"
      && typeof parsed.timestamp === "number"
      && typeof parsed.provider === "string"
      && typeof parsed.model === "string"
      && typeof parsed.status === "number"
      && typeof parsed.durationMs === "number") {
      return parsed;
    }
  } catch {
    /* skip partial / hand-edited lines, same as every other reader */
  }
  return null;
}

export interface IngestOptions {
  /** Ledger revision the caller recorded; any other file at the path makes the ingest stale. */
  expected: Pick<UsageLogRevision, "dev" | "ino">;
  /** Runs before every write transaction; throws to stop writing into a superseded index. */
  beforeWrite?: () => void;
  /** Monotonic milliseconds that size sub-transactions; tests inject a scripted clock. */
  now?: () => number;
}

/**
 * Ingest complete JSONL lines from `fromOffset` up to the ledger size observed
 * when the ingest starts, yielding after each read chunk and between the
 * sub-transactions a staged batch drains in. The fixed endpoint keeps
 * continuous appends from postponing completion; the next refresh picks them
 * up as a tail. Returns the rows this ingest actually inserted.
 */
export function* ingestSteps(
  dbHandle: Database,
  path: string,
  fromOffset: number,
  options: IngestOptions,
): Generator<void, number, unknown> {
  let inserted = 0;
  let pending: PendingRow[] = [];
  let pendingBytes = 0;
  let rowLimit = REQUEST_HISTORY_INITIAL_COMMIT_ROWS;
  const now = options.now ?? (() => performance.now());
  const insert = dbHandle.prepare(ROW_INSERT);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const sameFile = (candidate: { dev: number | bigint; ino: number | bigint }) =>
      Number(candidate.dev) === Number(options.expected.dev) && Number(candidate.ino) === Number(options.expected.ino);
    if (!sameFile(stat)) throw new RequestHistoryIndexStaleError("usage log changed while indexing");
    const size = Number(stat.size);
    const openFd = fd;
    let nextOffset = fromOffset;
    const assertSourceUnchanged = () => {
      // The fd keeps reading the inode we started on; a path that now names a
      // different file, or a file that shrank, makes this snapshot obsolete.
      let current: ReturnType<typeof statSync>;
      try {
        current = statSync(path);
      } catch {
        throw new RequestHistoryIndexStaleError("usage log removed while indexing");
      }
      if (!sameFile(current) || Number(fstatSync(openFd).size) < size) {
        throw new RequestHistoryIndexStaleError("usage log changed while indexing");
      }
    };
    // The first `take` pending rows, the offset just past their last line and
    // the running count land in one transaction. Taking every pending row
    // commits `nextOffset`, which also covers skipped lines after the last row.
    // Counts are read inside the transaction, so a second process tailing the
    // same generation cannot overwrite them; local state (queue, count and the
    // adaptive limit) advances only after COMMIT.
    const commit = (take: number, final: boolean) => {
      options.beforeWrite?.();
      assertSourceUnchanged();
      const offset = take < pending.length ? pending[take - 1]!.endOffset : nextOffset;
      let batchInserted = 0;
      const started = now();
      dbHandle.transaction(() => {
        for (let index = 0; index < take; index++) {
          // `changes` counts real inserts only; INSERT OR IGNORE replays add 0.
          batchInserted += insert.run(...pending[index]!.values).changes;
        }
        const storedOffset = metaNumber(dbHandle, HISTORY_META_KEYS.indexedOffset);
        setMeta(dbHandle, HISTORY_META_KEYS.indexedOffset, Math.max(storedOffset, offset));
        setMeta(dbHandle, HISTORY_META_KEYS.indexedRows, metaNumber(dbHandle, HISTORY_META_KEYS.indexedRows) + batchInserted);
        if (final) {
          // Another process may already have finished a later snapshot; source
          // metadata only moves forward, like the offset.
          if (size >= metaNumber(dbHandle, HISTORY_META_KEYS.sourceSize)) {
            setMeta(dbHandle, HISTORY_META_KEYS.sourceSize, size);
            setMeta(dbHandle, HISTORY_META_KEYS.sourceMtimeMs, Number(stat.mtimeMs));
          }
          setMeta(dbHandle, HISTORY_META_KEYS.builtAtMs, Date.now());
        }
      })();
      const elapsed = now() - started;
      inserted += batchInserted;
      for (let index = 0; index < take; index++) pendingBytes -= pending[index]!.sourceBytes;
      pending = pending.slice(take);
      rowLimit = nextCommitRowLimit(rowLimit, take, elapsed);
    };
    function* commitWithRetry(take: number, final: boolean): Generator<void, void, unknown> {
      for (let attempt = 0; ; attempt++) {
        try {
          commit(take, final);
          return;
        } catch (error) {
          if (!isSqliteBusy(error) || attempt >= BUSY_COMMIT_RETRIES) throw error;
        }
        yield;
      }
    }
    // Drain every staged row in sub-transactions of `rowLimit`, yielding between
    // them but not after the last, so no step ever suspends inside a transaction
    // and completion follows the final COMMIT in the same step, as before.
    function* drain(final: boolean): Generator<void, void, unknown> {
      for (;;) {
        const take = Math.min(rowLimit, pending.length);
        const last = take === pending.length;
        yield* commitWithRetry(take, final && last);
        if (last) return;
        yield;
      }
    }

    const readBuffer = Buffer.allocUnsafe(REQUEST_HISTORY_READ_CHUNK_BYTES);
    let position = fromOffset;
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let oversized = false;
    while (position < size) {
      const requested = Math.min(readBuffer.length, size - position);
      const bytesRead = readSync(fd, readBuffer, 0, requested, position);
      if (bytesRead === 0) throw new RequestHistoryIndexStaleError("usage log changed while indexing");
      let lineStart = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (readBuffer[index] !== 0x0a) continue;
        const segment = readBuffer.subarray(lineStart, index);
        const keep = !oversized && fragmentBytes + segment.length <= REQUEST_HISTORY_MAX_RECORD_BYTES;
        const line = !keep
          ? null
          : fragments.length === 0
            ? segment
            : Buffer.concat([...fragments, segment], fragmentBytes + segment.length);
        fragments = [];
        fragmentBytes = 0;
        oversized = false;
        lineStart = index + 1;
        nextOffset = position + index + 1;
        const entry = line ? parsedEntryFromLine(line.toString("utf-8")) : null;
        if (!entry) continue;
        pending.push({ values: extractRow(entry), endOffset: nextOffset, sourceBytes: line!.length });
        pendingBytes += line!.length;
        if (pending.length >= REQUEST_HISTORY_INSERT_BATCH || pendingBytes >= REQUEST_HISTORY_INSERT_BATCH_BYTES) {
          yield* drain(false);
        }
      }
      const remainder = readBuffer.subarray(lineStart, bytesRead);
      if (!oversized && fragmentBytes + remainder.length <= REQUEST_HISTORY_MAX_RECORD_BYTES) {
        // Copy because readBuffer is reused on the next iteration.
        fragments.push(Buffer.from(remainder));
        fragmentBytes += remainder.length;
      } else if (remainder.length > 0) {
        fragments = [];
        fragmentBytes = 0;
        oversized = true;
      }
      position += bytesRead;
      if (position < size) yield;
    }
    yield* drain(true);
    return inserted;
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Windows file locks: an unterminated prepared statement keeps the DB
    // file busy after close (verified on Bun 1.3.14). Finalize always.
    insert.finalize();
  }
}
