/**
 * Derived request-history index (RI-02, #6990).
 *
 * `usage.jsonl` stays canonical; this module maintains a rebuildable SQLite
 * projection (ADR-1, ADR-8). Each refresh verifies schema version and source
 * identity, then appends whatever complete JSONL rows arrived since the last
 * index. A missing, corrupt or stale index, or a replaced or truncated
 * source, triggers a full rebuild; canonical history is never touched.
 *
 * The refresh never monopolises the serving event loop. It runs as one
 * generator per process ("flight") whose steps are bounded: setup, one 64 KiB
 * ledger chunk, or publication. Async callers drive it in short slices with a
 * timer yield between them. The routing-time sync entry drives at most a small
 * budget, hands any remaining work to the background driver and throws
 * `RequestHistoryIndexBusyError`, which routing reads as unknown evidence.
 *
 * Reader contract: a sync caller gets a caught-up index or BusyError. An async
 * caller waits for the flight and then reads one generation: the previous
 * complete index plus a committed tail prefix, or a newly published rebuild.
 * A rebuild is written to a private file and published under a new generation
 * name (see ./generations), so no reader sees a partial index or, after the
 * ledger is replaced, rows the ledger no longer has.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { getConfigDir } from "../../config";
import { recordOwnedConfigPath } from "../../lib/config-ownership";
import {
  currentUsageLogRevision,
  encodePersistedRequestedModel,
  normalizeUsageEntryForTest,
  type PersistedUsageEntry,
  type UsageLogRevision,
} from "../../usage/log";
import {
  HISTORY_DDL,
  HISTORY_META_KEYS,
  HISTORY_SCHEMA_VERSION,
  historyIndexDir,
  historyIndexPath,
} from "./schema";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  InvalidCursorError,
  type HistoryCursor,
} from "./cursor";
import {
  ingestSteps,
  isSqliteBusy,
  isSqliteCorruption,
  metaValue,
  RequestHistoryIndexStaleError,
  setMeta,
} from "./ingest";
import {
  newestGenerationPath,
  newGenerationNames,
  RECLAIM_SERVING_MAX_WAL_BYTES,
  reclaimDatabase,
  removeAbandonedBuilds,
  removeBuildFiles,
  supersededGenerations,
} from "./generations";

export {
  REQUEST_HISTORY_INSERT_BATCH,
  REQUEST_HISTORY_MAX_RECORD_BYTES,
  REQUEST_HISTORY_READ_CHUNK_BYTES,
} from "./ingest";

export interface RequestHistoryIndexMeta {
  schemaVersion: number;
  dbPath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  indexedOffset: number;
  indexedRows: number;
  builtAtMs: number;
  lastError: string | null;
}

export interface RequestHistoryFilters {
  provider?: string;
  model?: string;
  requestedModel?: string;
  status?: number;
  conversationId?: string;
  surface?: string;
  inboundProtocol?: string;
  apiKeyId?: string;
  profileId?: string;
  fallback?: boolean;
  from?: number;
  to?: number;
}

export interface RequestHistoryPage {
  rows: PersistedUsageEntry[];
  nextCursor?: string;
  hasMore: boolean;
  meta: RequestHistoryIndexMeta;
}

export const REQUEST_HISTORY_MAX_PAGE_SIZE = 100;
export const REQUEST_HISTORY_DEFAULT_PAGE_SIZE = 50;
/** Longest stretch one async driver slice keeps the event loop. */
export const REQUEST_HISTORY_SLICE_MS = 25;
/** Longest stretch the routing-time sync entry keeps the event loop. */
export const REQUEST_HISTORY_SYNC_BUDGET_MS = 50;
// A serving connection must not park the event loop behind another process's
// write lock; contention fails fast and the ingest retries after a yield.
const BUSY_TIMEOUT_MS = 25;
// Ledger replacement or a superseded generation restarts a refresh at most this often.
const STALE_RESTARTS = 3;
// A read whose generation was replaced between settling and resuming retries this often.
const READ_ATTEMPTS = 5;

/** The index is being refreshed in the background; routing treats its evidence as unknown. */
export class RequestHistoryIndexBusyError extends Error {
  readonly code = "request_history_index_busy";
  constructor() {
    super("request-history index is refreshing in the background");
    this.name = "RequestHistoryIndexBusyError";
  }
}

/** The index was closed while a refresh was waiting on it. */
export class RequestHistoryIndexClosedError extends Error {
  readonly code = "request_history_index_closed";
  constructor() {
    super("request-history index was closed during a refresh");
    this.name = "RequestHistoryIndexClosedError";
  }
}

interface OpenGeneration {
  handle: Database;
  path: string;
}

interface Settled {
  meta: RequestHistoryIndexMeta;
  handle: Database;
}

interface Flight {
  steps: Generator<void, Settled, unknown>;
  promise: Promise<Settled>;
  resolve: (value: Settled) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  handedOff: boolean;
  done: boolean;
  failed: boolean;
  result?: Settled;
  error?: unknown;
}

// Old databases waiting to be reclaimed. Each one may checkpoint up to the WAL
// bound in a single statement, so the queue takes one file per timer turn and
// never runs inside a refresh step.
interface ReclaimQueue {
  pending: string[];
  maxWalBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
  finish: () => void;
}

let open: OpenGeneration | null = null;
// Handles of superseded generations whose WAL was too large to checkpoint on
// the serving loop. They take no more writes; teardown closes them.
let parked: Database[] = [];
let flight: Flight | null = null;
let reclaimQueue: ReclaimQueue | null = null;
let integrityReason: string | null = null;
let epoch = 0;
// Advances on every close; work queued before a close must not start afterwards.
let lifetime = 0;
let sliceMs = REQUEST_HISTORY_SLICE_MS;
let syncBudgetMs = REQUEST_HISTORY_SYNC_BUDGET_MS;

interface IndexPaths {
  dir: string;
  legacyPath: string;
  /** WAL size above which this flight leaves an old database for a later reclaim. */
  reclaimMaxWalBytes: number;
}

// Resolved once per flight: a suspended refresh never re-reads OPENCODEX_HOME.
function indexPaths(reclaimMaxWalBytes: number): IndexPaths {
  const configDir = getConfigDir();
  const dir = historyIndexDir(configDir);
  recordOwnedConfigPath(configDir, dir);
  return { dir, legacyPath: historyIndexPath(configDir), reclaimMaxWalBytes };
}

function readIndexedMeta(dbHandle: Database): Omit<RequestHistoryIndexMeta, "dbPath"> {
  const asNumber = (key: string): number => {
    const value = metaValue(dbHandle, key);
    const parsed = value === null ? NaN : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    schemaVersion: asNumber(HISTORY_META_KEYS.schemaVersion) || HISTORY_SCHEMA_VERSION,
    sourceSize: asNumber(HISTORY_META_KEYS.sourceSize),
    sourceMtimeMs: asNumber(HISTORY_META_KEYS.sourceMtimeMs),
    indexedOffset: asNumber(HISTORY_META_KEYS.indexedOffset),
    indexedRows: asNumber(HISTORY_META_KEYS.indexedRows),
    builtAtMs: asNumber(HISTORY_META_KEYS.builtAtMs),
    lastError: metaValue(dbHandle, HISTORY_META_KEYS.lastError),
  };
}

function settledFor(generation: OpenGeneration): Settled {
  return { meta: { dbPath: generation.path, ...readIndexedMeta(generation.handle) }, handle: generation.handle };
}

function sourceIdentity(): UsageLogRevision | null {
  return currentUsageLogRevision();
}

function readStoredMetaField(dbHandle: Database, key: string): string {
  return metaValue(dbHandle, key) ?? "";
}

function sourceIdentityMatches(dbHandle: Database, revision: UsageLogRevision | null): boolean {
  const stored = readIndexedMeta(dbHandle);
  if (revision === null) return stored.sourceSize === 0;
  const storedPath = readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourcePath);
  if (!storedPath) return false;
  const storedDev = Number(readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourceDev));
  const storedIno = Number(readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourceIno));
  const storedBirthtimeMs = Number(readStoredMetaField(dbHandle, HISTORY_META_KEYS.sourceBirthtimeMs));
  return storedPath === revision.path
    && storedDev === Number(revision.dev)
    && storedIno === Number(revision.ino)
    && storedBirthtimeMs === Number(revision.birthtimeMs);
}

function sameLedger(before: UsageLogRevision | null, after: UsageLogRevision | null): boolean {
  if (before === null || after === null) return before === after;
  return before.path === after.path
    && Number(before.dev) === Number(after.dev)
    && Number(before.ino) === Number(after.ino)
    && Number(before.birthtimeMs) === Number(after.birthtimeMs)
    && Number(after.size) >= Number(before.size);
}

function recordSourceMeta(dbHandle: Database, revision: UsageLogRevision | null): void {
  setMeta(dbHandle, HISTORY_META_KEYS.sourcePath, revision?.path ?? "");
  setMeta(dbHandle, HISTORY_META_KEYS.sourceDev, revision?.dev ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceIno, revision?.ino ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceBirthtimeMs, revision?.birthtimeMs ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceSize, revision?.size ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceMtimeMs, revision?.mtimeMs ?? 0);
}

/** Teardown: close the open generation and any parked handles. */
function closeOpenGeneration(): void {
  const handles = open ? [open.handle, ...parked] : parked;
  open = null;
  parked = [];
  for (const handle of handles) {
    try { handle.close(); } catch { /* already closed */ }
  }
}

/**
 * Stop using the open generation during a refresh. Closing the last connection
 * checkpoints its whole WAL in one statement; a WAL a reader elsewhere kept
 * from checkpointing can be hundreds of MB, so above the bound the handle is
 * parked instead and closed at teardown. A parked generation is superseded:
 * it receives no commits, so no autocheckpoint runs on it either.
 */
function retireOpenGeneration(maxWalBytes: number): void {
  if (!open) return;
  const { handle, path } = open;
  open = null;
  let walBytes = 0;
  try { walBytes = statSync(`${path}-wal`).size; } catch { /* no WAL */ }
  if (walBytes > maxWalBytes) {
    parked.push(handle);
    return;
  }
  try { handle.close(); } catch { /* already closed */ }
}

function cancelReclaim(): void {
  const queue = reclaimQueue;
  reclaimQueue = null;
  if (!queue) return;
  if (queue.timer) clearTimeout(queue.timer);
  queue.finish();
}

/** Replace any queued reclaim: a later list covers everything an earlier one held. */
function scheduleReclaim(paths: string[], maxWalBytes: number): void {
  cancelReclaim();
  if (paths.length === 0) return;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const queue: ReclaimQueue = { pending: [...paths], maxWalBytes, timer: null, done, finish };
  const step = () => {
    queue.timer = null;
    if (reclaimQueue !== queue) return;
    const next = queue.pending.shift();
    if (next === undefined) {
      reclaimQueue = null;
      queue.finish();
      return;
    }
    reclaimDatabase(next, queue.maxWalBytes);
    queue.timer = setTimeout(step, 0);
  };
  reclaimQueue = queue;
  queue.timer = setTimeout(step, 0);
}

function openGeneration(path: string): Database {
  const handle = new Database(path, { readwrite: true });
  try {
    handle.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    handle.exec("PRAGMA journal_mode = WAL");
    // Until that first statement this connection was invisible to another
    // process reclaiming the generation; from here on it blocks reclamation.
    if (!existsSync(path)) throw new RequestHistoryIndexStaleError("index generation reclaimed while opening");
    return handle;
  } catch (error) {
    try { handle.close(); } catch { /* already unusable */ }
    if (!existsSync(path)) throw new RequestHistoryIndexStaleError("index generation reclaimed while opening");
    throw error;
  }
}

/**
 * Why the open generation cannot be used, or null when it can. Replaces the
 * former per-refresh `PRAGMA quick_check`, which is O(index size) and cost
 * seconds on a multi-GB index; corruption is instead caught where a statement
 * reports it (`noteRequestHistoryIndexError`).
 */
function rebuildReason(dbHandle: Database, revision: UsageLogRevision | null): string | null {
  try {
    const storedVersion = metaValue(dbHandle, HISTORY_META_KEYS.schemaVersion);
    if (storedVersion !== String(HISTORY_SCHEMA_VERSION)) {
      return `schema version ${storedVersion ?? "missing"} -> ${HISTORY_SCHEMA_VERSION}; index rebuilt`;
    }
    if (!sourceIdentityMatches(dbHandle, revision)) return "source identity changed; index rebuilt";
    return null;
  } catch (error) {
    if (isSqliteBusy(error)) throw error;
    return isSqliteCorruption(error) ? "integrity error; index rebuilt" : "index unreadable; rebuilt";
  }
}

function* refreshSteps(paths: IndexPaths, forcedReason: string | null): Generator<void, Settled, unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return yield* refreshOnce(paths, forcedReason);
    } catch (error) {
      if (!(error instanceof RequestHistoryIndexStaleError) || attempt >= STALE_RESTARTS) throw error;
    }
  }
}

function* refreshOnce(paths: IndexPaths, forcedReason: string | null): Generator<void, Settled, unknown> {
  stepPhase = "refresh";
  const { dir } = paths;
  const revision = sourceIdentity();
  let reason = forcedReason ?? integrityReason;
  if (reason === null) {
    const newest = newestGenerationPath(dir);
    if (newest === null) {
      retireOpenGeneration(paths.reclaimMaxWalBytes);
      reason = "index missing; built from usage ledger";
    } else if (open?.path !== newest) {
      // First open, or another process published a newer generation.
      retireOpenGeneration(paths.reclaimMaxWalBytes);
      try {
        open = { handle: openGeneration(newest), path: newest };
      } catch (error) {
        if (isSqliteBusy(error) || error instanceof RequestHistoryIndexStaleError) throw error;
        reason = isSqliteCorruption(error) ? "integrity error; index rebuilt" : "index unreadable; rebuilt";
      }
      if (open) scheduleReclaim(supersededGenerations(dir, newest), paths.reclaimMaxWalBytes);
    }
    if (reason === null) reason = rebuildReason(open!.handle, revision);
  }
  if (reason === null) {
    const generation = open!;
    const current = readIndexedMeta(generation.handle);
    if (revision === null) {
      // Source gone: the derived index must not outlive its canonical ledger.
      if (current.indexedRows > 0) reason = "source ledger missing; index reset";
    } else if (Number(revision.size) < current.indexedOffset) {
      // Truncated source: offsets no longer make sense.
      reason = "source truncated; index rebuilt";
    } else if (current.indexedOffset < Number(revision.size)) {
      stepPhase = "tail";
      const inserted = yield* ingestSteps(generation.handle, revision.path, current.indexedOffset, {
        expected: revision,
        beforeWrite: () => {
          if (open !== generation || newestGenerationPath(dir) !== generation.path) {
            throw new RequestHistoryIndexStaleError("index generation replaced while indexing");
          }
        },
      });
      // A clean tail ingest proves the index is healthy: clear any earlier
      // rebuild marker so status readers can distinguish rebuilds from tails.
      if (inserted > 0) setMeta(generation.handle, HISTORY_META_KEYS.lastError, "");
    }
    if (reason === null) return settledFor(generation);
  }
  return yield* rebuildSteps(paths, reason, revision);
}

/**
 * Build a complete generation privately, then publish it under a new name.
 * Readers keep waiting (async) or get BusyError (sync) until publication.
 */
function* rebuildSteps(
  paths: IndexPaths,
  reason: string,
  revision: UsageLogRevision | null,
): Generator<void, Settled, unknown> {
  const { dir } = paths;
  stepPhase = "prepare";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  removeAbandonedBuilds(dir);
  // Rows of a superseded generation stay unreachable for the whole build, and
  // health evidence computed from them stops being served from cache.
  retireOpenGeneration(paths.reclaimMaxWalBytes);
  epoch += 1;
  const { buildPath, generationPath } = newGenerationNames(dir);
  removeBuildFiles(buildPath);
  let build: Database | null = new Database(buildPath, { create: true, readwrite: true });
  let published = false;
  try {
    // A private build file needs no crash durability: an interrupted build is
    // discarded. WAL is enabled just before publication for future readers.
    // MEMORY keeps in-process ROLLBACK without a rollback file: DELETE created
    // and removed one per commit, which dominated commit time on Windows
    // (devlog/_plan/261013_rt284_l1_owner_bundle/060_windows_rebuild_lag.md).
    build.exec("PRAGMA journal_mode = MEMORY");
    build.exec("PRAGMA synchronous = OFF");
    build.exec(HISTORY_DDL);
    const fresh = build;
    fresh.transaction(() => {
      setMeta(fresh, HISTORY_META_KEYS.schemaVersion, HISTORY_SCHEMA_VERSION);
      setMeta(fresh, HISTORY_META_KEYS.indexedOffset, 0);
      setMeta(fresh, HISTORY_META_KEYS.indexedRows, 0);
      setMeta(fresh, HISTORY_META_KEYS.builtAtMs, Date.now());
      setMeta(fresh, HISTORY_META_KEYS.lastError, reason);
      recordSourceMeta(fresh, revision);
    })();
    stepPhase = "ingest";
    if (revision !== null) yield* ingestSteps(fresh, revision.path, 0, { expected: revision });
    stepPhase = "publish";
    if (!sameLedger(revision, sourceIdentity())) {
      throw new RequestHistoryIndexStaleError("usage log changed while rebuilding");
    }
    // The specific reason survives publication (#6990 used to overwrite it).
    fresh.transaction(() => {
      setMeta(fresh, HISTORY_META_KEYS.lastError, reason);
      setMeta(fresh, HISTORY_META_KEYS.builtAtMs, Date.now());
    })();
    fresh.exec("PRAGMA journal_mode = WAL");
    build.close();
    build = null;
    renameSync(buildPath, generationPath);
    published = true;
  } finally {
    if (build) {
      try { build.close(); } catch { /* already closed */ }
    }
    if (!published) removeBuildFiles(buildPath);
  }
  integrityReason = null;
  epoch += 1;
  open = { handle: openGeneration(generationPath), path: generationPath };
  stepPhase = "published";
  // Older generations and the single-file index from before generations go
  // once nothing has them open, after this refresh has already settled.
  scheduleReclaim([...supersededGenerations(dir, generationPath), paths.legacyPath], paths.reclaimMaxWalBytes);
  return settledFor(open);
}

function startFlight(forcedReason: string | null, reclaimMaxWalBytes = RECLAIM_SERVING_MAX_WAL_BYTES): Flight {
  const paths = indexPaths(reclaimMaxWalBytes);
  let resolve!: (value: Settled) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Settled>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // A flight handed off by a sync caller may have no awaiters at all.
  promise.catch(() => undefined);
  const started: Flight = {
    steps: refreshSteps(paths, forcedReason),
    promise,
    resolve,
    reject,
    timer: null,
    running: false,
    handedOff: false,
    done: false,
    failed: false,
  };
  flight = started;
  return started;
}

function finishFlight(target: Flight, outcome: { result: Settled } | { error: unknown }): void {
  target.done = true;
  if (target.timer) clearTimeout(target.timer);
  target.timer = null;
  if (flight === target) flight = null;
  // Health evidence cached as unknown during a background refresh expires now.
  if (target.handedOff) epoch += 1;
  if ("result" in outcome) {
    target.result = outcome.result;
    target.resolve(outcome.result);
    return;
  }
  target.failed = true;
  target.error = outcome.error;
  noteRequestHistoryIndexError(outcome.error);
  target.reject(outcome.error);
}

/** Advance whole steps until the flight settles or the budget runs out; true when settled. */
function driveFlight(target: Flight, budgetMs: number): boolean {
  if (target.done) return true;
  if (target.running) return false;
  const deadline = performance.now() + budgetMs;
  target.running = true;
  try {
    for (;;) {
      const observer = stepObserver;
      const phaseBefore = stepPhase;
      const stepStarted = observer ? performance.now() : 0;
      const step = target.steps.next();
      if (observer) observer({ phase: phaseBefore === stepPhase ? stepPhase : `${phaseBefore}->${stepPhase}`, startedAt: stepStarted, ms: performance.now() - stepStarted });
      if (step.done) {
        finishFlight(target, { result: step.value });
        return true;
      }
      if (performance.now() >= deadline) return false;
    }
  } catch (error) {
    finishFlight(target, { error });
    return true;
  } finally {
    target.running = false;
  }
}

function scheduleFlight(target: Flight): void {
  if (target.done || target.timer || flight !== target) return;
  target.handedOff = true;
  // setTimeout(0), not setImmediate: on Bun 1.4 an in-process HTTP exchange
  // waited ~50 ms per request behind setImmediate-chained slices and ~0.1 ms
  // behind timers. Same yield as the cooperative usage scanner.
  target.timer = setTimeout(() => {
    target.timer = null;
    if (flight !== target || target.done) return;
    if (!driveFlight(target, sliceMs)) scheduleFlight(target);
  }, 0);
}

function openForRead(): Promise<Settled> {
  let target = flight;
  if (!target) {
    target = startFlight(null);
    if (!driveFlight(target, sliceMs)) scheduleFlight(target);
  }
  return target.promise;
}

/**
 * Routing-time refresh. Returns the caught-up index meta, or throws
 * `RequestHistoryIndexBusyError` after handing unfinished work to the
 * background. A refresh already running elsewhere is never driven here, so
 * one routing decision pays the budget at most once.
 */
export function openRequestHistoryIndexSync(): RequestHistoryIndexMeta {
  if (flight) throw new RequestHistoryIndexBusyError();
  const target = startFlight(null);
  if (!driveFlight(target, syncBudgetMs)) {
    scheduleFlight(target);
    throw new RequestHistoryIndexBusyError();
  }
  if (target.failed) throw target.error;
  return target.result!.meta;
}

/**
 * Open (and refresh) the index. Single-flight: concurrent callers share one
 * refresh, which runs in slices between event-loop turns. Missing, corrupt and
 * stale indexes are repaired and reflected in the returned meta; the promise
 * rejects only for transient failures or `RequestHistoryIndexClosedError`.
 */
export function openRequestHistoryIndex(): Promise<RequestHistoryIndexMeta> {
  return openForRead().then(settled => settled.meta);
}

/**
 * Run `read` synchronously against the refreshed index. The handle is checked
 * in the same turn that runs `read`: a rebuild started between the refresh
 * settling and this continuation closes that handle, so the read waits for the
 * next generation instead.
 */
export async function withRequestHistoryIndex<T>(
  read: (handle: Database, meta: RequestHistoryIndexMeta) => T,
): Promise<T> {
  const token = lifetime;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const settled = await openForRead();
    if (lifetime !== token) throw new RequestHistoryIndexClosedError();
    if (open?.handle !== settled.handle) continue;
    try {
      return read(settled.handle, settled.meta);
    } catch (error) {
      noteRequestHistoryIndexError(error);
      throw error;
    }
  }
  throw new RequestHistoryIndexBusyError();
}

/** Close the index; a refresh in flight is cancelled and its private build removed. */
export function closeRequestHistoryIndex(): void {
  const target = flight;
  flight = null;
  lifetime += 1;
  if (target && !target.done) {
    if (target.timer) clearTimeout(target.timer);
    target.timer = null;
    target.done = true;
    target.failed = true;
    // Runs every pending `finally`: statements finalized, ledger fd and build
    // handle closed, unpublished build files removed.
    try { target.steps.return(undefined as never); } catch { /* cleanup is best effort */ }
    target.error = new RequestHistoryIndexClosedError();
    target.reject(target.error);
  }
  closeOpenGeneration();
  cancelReclaim();
  integrityReason = null;
  epoch += 1;
}

/** Force a full rebuild from the canonical ledger (CLI / tests). */
export async function rebuildRequestHistoryIndex(): Promise<RequestHistoryIndexMeta> {
  const token = lifetime;
  while (flight) {
    await flight.promise.catch(() => undefined);
    // A close while this rebuild was queued cancels it as well.
    if (lifetime !== token) throw new RequestHistoryIndexClosedError();
  }
  // A manual rebuild is an operator action (`ocx logs rebuild-index` runs in
  // its own process), so it also reclaims old files whose WAL checkpoint is
  // too large for a serving process.
  const target = startFlight("manual rebuild requested", Number.POSITIVE_INFINITY);
  if (!driveFlight(target, sliceMs)) scheduleFlight(target);
  const { meta } = await target.promise;
  // The operator asked for a clean index directory: wait for old files too.
  await reclaimQueue?.done;
  if (lifetime !== token) throw new RequestHistoryIndexClosedError();
  return meta;
}

/**
 * Report a statement error from a reader of the index. Corruption marks the
 * index for a rebuild on the next refresh; other errors are ignored here.
 */
export function noteRequestHistoryIndexError(error: unknown): void {
  if (isSqliteCorruption(error)) integrityReason = "integrity error; index rebuilt";
}

/**
 * Changes when a rebuild is published or a background refresh finishes, so
 * callers can stop serving results cached while the index was busy.
 */
export function requestHistoryIndexEpoch(): number {
  return epoch;
}

/** Test seam: shrink the slice and sync budgets (0 = one step per drive); null restores defaults. */
/** One generator step as the slice driver ran it, for tests that attribute event-loop gaps. */
export interface RequestHistoryStepSample {
  phase: string;
  startedAt: number;
  ms: number;
}

// Test-only attribution: which part of a refresh a step ran (refresh, tail,
// prepare, ingest, publish, published). Plain assignments; no cost unless an
// observer is installed.
let stepPhase = "refresh";
let stepObserver: ((sample: RequestHistoryStepSample) => void) | null = null;

/** Test seam: observe every driven step with its phase and duration; null removes it. */
export function setRequestHistoryStepObserverForTests(observer: ((sample: RequestHistoryStepSample) => void) | null): void {
  stepObserver = observer;
}

export function setRequestHistoryBudgetsForTests(budgets: { sliceMs?: number; syncBudgetMs?: number } | null): void {
  sliceMs = budgets?.sliceMs ?? REQUEST_HISTORY_SLICE_MS;
  syncBudgetMs = budgets?.syncBudgetMs ?? REQUEST_HISTORY_SYNC_BUDGET_MS;
}

type HistoryQueryRow = {
  row_json: string;
  timestamp?: number;
  request_id?: string;
};

function queryRows(
  handle: Database,
  filters: RequestHistoryFilters,
  cursor: HistoryCursor | null,
  limit: number,
): { rows: Array<HistoryQueryRow>; fetched: number } {
  const where: string[] = [];
  const values: Array<string | number> = [];
  const add = (clause: string, value: string | number) => {
    where.push(clause);
    values.push(value);
  };
  if (filters.provider !== undefined) add("provider = ?", filters.provider);
  if (filters.model !== undefined) add("model = ?", filters.model);
  // Rows store the bounded encoded form, so the lookup value must be encoded the
  // same way — short selectors encode to themselves and still match verbatim.
  if (filters.requestedModel !== undefined) add("requested_model = ?", encodePersistedRequestedModel(filters.requestedModel));
  if (filters.status !== undefined) add("status = ?", filters.status);
  if (filters.conversationId !== undefined) add("conversation_id = ?", filters.conversationId);
  if (filters.surface !== undefined) add("surface = ?", filters.surface);
  if (filters.inboundProtocol !== undefined) add("inbound_protocol = ?", filters.inboundProtocol);
  if (filters.apiKeyId !== undefined) add("api_key_id = ?", filters.apiKeyId);
  if (filters.profileId !== undefined) add("profile_id = ?", filters.profileId);
  if (filters.fallback !== undefined) add("fallback = ?", filters.fallback ? 1 : 0);
  if (filters.from !== undefined) add("timestamp >= ?", filters.from);
  if (filters.to !== undefined) add("timestamp <= ?", filters.to);
  if (cursor) {
    where.push("(timestamp < ? OR (timestamp = ? AND request_id < ?))");
    values.push(cursor.t, cursor.t, cursor.i);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const rows = handle.query(
    `SELECT row_json, timestamp, request_id FROM requests${whereSql} ORDER BY timestamp DESC, request_id DESC LIMIT ?`,
  ).all(...values, limit + 1) as Array<HistoryQueryRow>;
  return { rows, fetched: rows.length };
}

function hydrateRow(row: HistoryQueryRow | undefined): PersistedUsageEntry | null {
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.row_json) as PersistedUsageEntry;
    if (parsed && typeof parsed === "object" && typeof parsed.requestId === "string") {
      return normalizeUsageEntryForTest(parsed);
    }
  } catch {
    /* defensive: a damaged row is skipped, canonical ledger unaffected */
  }
  return null;
}

export async function queryRequestHistory(
  filters: RequestHistoryFilters,
  rawCursor: string | null | undefined,
  pageSize: number | undefined,
): Promise<RequestHistoryPage> {
  const cursor = decodeHistoryCursor(rawCursor);
  if (rawCursor !== null && rawCursor !== undefined && cursor === null) {
    throw new InvalidCursorError();
  }
  const limit = Math.min(
    Math.max(1, Math.trunc(pageSize ?? REQUEST_HISTORY_DEFAULT_PAGE_SIZE)),
    REQUEST_HISTORY_MAX_PAGE_SIZE,
  );
  // Rows and meta come from the same generation handle.
  const { rows, fetched, meta } = await withRequestHistoryIndex((handle, indexMeta) => ({
    ...queryRows(handle, filters, cursor, limit),
    meta: indexMeta,
  }));
  const hasMore = fetched > limit;
  const pageRows = rows.slice(0, limit);
  const entries: PersistedUsageEntry[] = [];
  for (const row of pageRows) {
    const entry = hydrateRow(row);
    if (entry) entries.push(entry);
  }
  let nextCursor: string | undefined;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = encodeHistoryCursor({ t: last.timestamp!, i: last.request_id! });
  }
  return { rows: entries, ...(nextCursor ? { nextCursor } : {}), hasMore, meta };
}

export async function requestHistoryRowById(requestId: string): Promise<PersistedUsageEntry | null> {
  const row = await withRequestHistoryIndex(handle =>
    handle.query("SELECT row_json FROM requests WHERE request_id = ?").get(requestId) as
      | { row_json: string }
      | undefined);
  return hydrateRow(row);
}

export async function requestHistoryIndexStatus(): Promise<RequestHistoryIndexMeta> {
  return openRequestHistoryIndex();
}

/**
 * Raw handle for synchronous readers, valid right after
 * `openRequestHistoryIndexSync()` returns and until the next published
 * generation or `closeRequestHistoryIndex()`. Async readers use
 * `withRequestHistoryIndex()`, which revalidates the handle across the await.
 */
export function requestHistoryDb(): Database {
  if (!open) throw new Error("request-history index is not open");
  return open.handle;
}
