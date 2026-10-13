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
import { open as openFileAsync, rename as renameAsync } from "node:fs/promises";
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
  removeAbandonedBuilds,
  removeBuildFiles,
  removeBuildFilesWithRetry,
  supersededGenerations,
} from "./generations";
import { createBuildDatabase, finishBuildMeta } from "./build-file";
import { IndexWorkerJob } from "./rebuild-job";

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
/**
 * Ledger size from which a full rebuild runs on a worker thread. Below it the
 * cooperative inline build finishes in a few steps, and the routing-time sync
 * entry can still settle a small cold index in one call.
 */
export const REQUEST_HISTORY_WORKER_MIN_BYTES = 1024 * 1024;
/** WAL size after a tail commit from which a worker checkpoints the serving generation. */
export const REQUEST_HISTORY_CHECKPOINT_WAL_BYTES = 4 * 1024 * 1024;
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

/** The outcome of one publication I/O request, delivered as the value of its yield. */
type IoOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * A file operation a flight step asks its driver to run. The routing-time sync
 * driver runs `runSync` inline, as before; the async drivers start `runAsync`
 * and resume the flight from a timer once it settles, so a slow rename or an
 * on-access scan waits off the serving loop. A request without `runSync`
 * (the worker rebuild) is never run by the sync driver: it hands the flight
 * off and the background driver starts it.
 */
interface IoRequest {
  kind: "io";
  phase: string;
  runSync?: () => void;
  runAsync: () => Promise<void>;
}

type StepYield = void | IoRequest;
type FlightSteps = Generator<StepYield, Settled, IoOutcome | undefined>;
type DriveMode = "sync" | "async";

interface Flight {
  steps: FlightSteps;
  /** The I/O request an async driver started; the generator is not advanced until it settles. */
  waiting: IoRequest | null;
  /** A settled I/O outcome not yet delivered; the next drive consumes it exactly once. */
  pendingOutcome: IoOutcome | null;
  /** An async-only request the sync driver handed off; the next async drive starts it. */
  deferred: IoRequest | null;
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

// Old databases being reclaimed by an index worker: reclaiming opens each one,
// switches its journal mode (a checkpoint) and deletes it, none of which may
// run on the serving thread. One job per publication; a newer list replaces it.
interface ReclaimQueue {
  job: IndexWorkerJob;
  done: Promise<void>;
}

let open: OpenGeneration | null = null;
// Handles of superseded generations whose WAL was too large to checkpoint on
// the serving loop. They take no more writes; teardown closes them.
let parked: Database[] = [];
let flight: Flight | null = null;
let reclaimQueue: ReclaimQueue | null = null;
// At most one WAL checkpoint job at a time.
let checkpointJob: Promise<void> | null = null;
// A worker rebuild hands reclamation over once its worker has exited (it held
// the superseded generation open until then); a manual rebuild waits for it.
let reclaimHandoff: Promise<void> | null = null;
let integrityReason: string | null = null;
let epoch = 0;
// Advances on every close; work queued before a close must not start afterwards.
let lifetime = 0;
let sliceMs = REQUEST_HISTORY_SLICE_MS;
let syncBudgetMs = REQUEST_HISTORY_SYNC_BUDGET_MS;
let rebuildWorkerMode: RequestHistoryRebuildWorkerMode = "auto";

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
  // Its pending request rejects, which settles `done`.
  trackIo(queue.job.dispose());
}

/** Replace any queued reclaim: a later list covers everything an earlier one held. */
function scheduleReclaim(paths: string[], maxWalBytes: number): void {
  cancelReclaim();
  // Only files that exist: most publications have nothing to reclaim and spawn no worker.
  const pending = paths.filter(path => existsSync(path));
  if (pending.length === 0) return;
  const job = new IndexWorkerJob();
  const done = job.reclaim(pending, maxWalBytes).then(() => undefined, () => undefined).then(() => {
    if (reclaimQueue?.job === job) reclaimQueue = null;
    trackIo(job.dispose());
  });
  reclaimQueue = { job, done };
  trackIo(done);
}

/**
 * Serving connections never autocheckpoint: a checkpoint syncs the database
 * file, which cost up to a second on hosted Windows. Once a tail leaves the
 * WAL above the bound, a worker checkpoints it (PASSIVE: readers are never
 * blocked, and a pinned reader only defers it to a later tail).
 */
const CHECKPOINT_RETRY_MS = 5_000;
let checkpointRetryMs = CHECKPOINT_RETRY_MS;
const CHECKPOINT_ATTEMPTS = 12;

function scheduleCheckpoint(path: string, attempt = 1): void {
  if (checkpointJob) return;
  let walBytes = 0;
  try { walBytes = statSync(`${path}-wal`).size; } catch { return; }
  if (walBytes < REQUEST_HISTORY_CHECKPOINT_WAL_BYTES) return;
  const token = lifetime;
  const job = new IndexWorkerJob();
  let complete = false;
  const run = job.checkpoint(path).then(done => { complete = done; }, () => undefined).then(() => job.dispose());
  checkpointJob = trackIo(run).then(() => {
    checkpointJob = null;
    if (complete || attempt >= CHECKPOINT_ATTEMPTS) return;
    // A reader pinned part of the WAL, and nothing guarantees another tail
    // soon: retry while this generation is still the one being served.
    const retry = setTimeout(() => {
      if (lifetime === token && open?.path === path) scheduleCheckpoint(path, attempt + 1);
    }, checkpointRetryMs);
    (retry as { unref?: () => void }).unref?.();
  });
}

function openGeneration(path: string): Database {
  const handle = new Database(path, { readwrite: true });
  try {
    handle.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    handle.exec("PRAGMA journal_mode = WAL");
    // The index is a rebuildable projection: a crash may lose its last tail
    // commits (rows and offset together), never consistency. NORMAL keeps an
    // fsync out of every serving-thread commit; FULL cost up to a second on
    // hosted Windows runners.
    handle.exec("PRAGMA synchronous = NORMAL");
    handle.exec("PRAGMA wal_autocheckpoint = 0");
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

function* refreshSteps(paths: IndexPaths, forcedReason: string | null): FlightSteps {
  for (let attempt = 1; ; attempt++) {
    try {
      return yield* refreshOnce(paths, forcedReason);
    } catch (error) {
      if (!(error instanceof RequestHistoryIndexStaleError) || attempt >= STALE_RESTARTS) throw error;
    }
  }
}

function* refreshOnce(paths: IndexPaths, forcedReason: string | null): FlightSteps {
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
      if (inserted > 0) {
        setMeta(generation.handle, HISTORY_META_KEYS.lastError, "");
        scheduleCheckpoint(generation.path);
      }
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
): FlightSteps {
  const { dir } = paths;
  stepPhase = "prepare";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  removeAbandonedBuilds(dir);
  const onWorker = revision !== null && rebuildOnWorker(revision);
  // Rows of a superseded generation stay unreachable for the whole build, and
  // health evidence computed from them stops being served from cache.
  // The worker path retires it only once its worker holds it open.
  if (!onWorker) retireOpenGeneration(paths.reclaimMaxWalBytes);
  epoch += 1;
  const { buildPath } = newGenerationNames(dir);
  removeBuildFiles(buildPath);
  if (onWorker) {
    return yield* workerRebuildSteps(paths, reason, revision!, buildPath);
  }
  // Captured once: a later test reset cannot redirect this publication.
  const io = publishIo;
  const resource: { renamed: boolean; pending: Promise<void> | null } = { renamed: false, pending: null };
  let build: Database | null = createBuildDatabase(buildPath, reason, revision);
  let published = false;
  let generationPath = "";
  try {
    // WAL is enabled just before publication for future readers.
    const fresh = build;
    stepPhase = "ingest";
    if (revision !== null) yield* ingestSteps(fresh, revision.path, 0, { expected: revision });
    // Publication runs as separate steps so each synchronous part is its own
    // sample, and the rename and warm-up wait off the loop when async-driven.
    yield;
    stepPhase = "publish-meta";
    if (!sameLedger(revision, sourceIdentity())) {
      throw new RequestHistoryIndexStaleError("usage log changed while rebuilding");
    }
    finishBuildMeta(fresh, reason);
    yield;
    stepPhase = "publish-wal";
    fresh.exec("PRAGMA journal_mode = WAL");
    yield;
    stepPhase = "publish-close";
    build.close();
    build = null;
    // Named at publication, above every generation already published, so a
    // generation another process published during this build cannot outrank it.
    const target = newGenerationNames(dir).generationPath;
    generationPath = target;
    // Recorded by the operation itself: a close can return this generator
    // while the rename is still in flight, and its outcome must still decide
    // whether the build is cleanup's to remove.
    yield* awaitIo({
      kind: "io",
      phase: "publish-rename",
      runSync: () => {
        io.renameSync(buildPath, target);
        resource.renamed = true;
      },
      runAsync: () => {
        const operation = io.rename(buildPath, target).then(() => { resource.renamed = true; });
        resource.pending = trackIo(operation);
        return operation;
      },
    });
    published = true;
  } finally {
    if (build) {
      try { build.close(); } catch { /* already closed */ }
    }
    if (!published) {
      const pending = resource.pending;
      // A rename still in flight owns the build: remove it only once that
      // rename has failed. A rename that succeeded published a complete
      // generation, which ordinary adoption or reclamation handles.
      if (pending) trackIo(pending.then(() => { if (!resource.renamed) removeBuildFiles(buildPath); }));
      else removeBuildFiles(buildPath);
    }
  }
  stepPhase = "publish-warm";
  yield* awaitIo({
    kind: "io",
    phase: "publish-warm",
    // The sync driver opens directly, as it always has.
    runSync: () => {},
    runAsync: () => {
      const operation = io.warm(generationPath).catch((error: unknown) => {
        if ((error as { code?: unknown } | null)?.code === "ENOENT") {
          throw new RequestHistoryIndexStaleError("index generation reclaimed while publishing");
        }
        // Best effort: the synchronous open below decides.
      });
      trackIo(operation);
      return operation;
    },
  });
  stepPhase = "publish-open";
  const settled = adoptPublished(paths, generationPath, revision, path => io.openGeneration(path, openGeneration));
  scheduleReclaimAfter(paths, generationPath);
  return settled;
}

/** Older generations and the single-file index from before generations go once nothing has them open. */
function scheduleReclaimAfter(paths: IndexPaths, generationPath: string): void {
  scheduleReclaim([...supersededGenerations(paths.dir, generationPath), paths.legacyPath], paths.reclaimMaxWalBytes);
}

/** Open a just-published generation, check it is still current, and make it the serving index. */
function adoptPublished(
  paths: IndexPaths,
  generationPath: string,
  revision: UsageLogRevision | null,
  openPublished: (path: string) => Database,
): Settled {
  const { dir } = paths;
  assertPublishable(dir, generationPath, revision);
  const handle = openPublished(generationPath);
  try {
    assertPublishable(dir, generationPath, revision);
  } catch (error) {
    try { handle.close(); } catch { /* already unusable */ }
    throw error;
  }
  integrityReason = null;
  epoch += 1;
  open = { handle, path: generationPath };
  return settledFor(open);
}

function rebuildOnWorker(revision: UsageLogRevision): boolean {
  if (rebuildWorkerMode === "inline") return false;
  if (rebuildWorkerMode === "worker") return true;
  return Number(revision.size) >= REQUEST_HISTORY_WORKER_MIN_BYTES;
}

/**
 * Full rebuild of a large ledger on a worker thread. The serving thread only
 * checks the ledger, names the generation, and opens it once the worker has
 * published it and holds it open; every other synchronous SQLite and file
 * step of the build runs on the worker (see ./rebuild-worker).
 *
 * The worker first holds the superseded generation open, so the serving
 * thread's close of it is not the last connection and checkpoints nothing;
 * the worker's own close does that. Reclamation therefore starts only after
 * the worker has exited.
 */
function* workerRebuildSteps(
  paths: IndexPaths,
  reason: string,
  revision: UsageLogRevision,
  buildPath: string,
): FlightSteps {
  const { dir } = paths;
  const worker: { job: IndexWorkerJob | null } = { job: null };
  const token = lifetime;
  let adopted: string | null = null;
  try {
    stepPhase = "worker-hold";
    const previous = open?.path ?? null;
    yield* awaitIo({
      kind: "io",
      phase: "worker-hold",
      runAsync: async () => {
        const job = new IndexWorkerJob();
        worker.job = job;
        if (previous !== null) await job.hold(previous);
      },
    });
    stepPhase = "prepare";
    retireOpenGeneration(paths.reclaimMaxWalBytes);
    stepPhase = "worker-build";
    yield* awaitIo({
      kind: "io",
      phase: "worker-build",
      runAsync: async () => { await worker.job!.build(buildPath, reason, revision); },
    });
    stepPhase = "publish-meta";
    if (!sameLedger(revision, sourceIdentity())) {
      throw new RequestHistoryIndexStaleError("usage log changed while rebuilding");
    }
    const generationPath = newGenerationNames(dir).generationPath;
    yield* awaitIo({
      kind: "io",
      phase: "worker-publish",
      runAsync: () => worker.job!.publish(buildPath, generationPath),
    });
    stepPhase = "publish-open";
    const settled = adoptPublished(paths, generationPath, revision, path => publishIo.openGeneration(path, openGeneration));
    adopted = generationPath;
    return settled;
  } finally {
    // Runs on success (after the serving thread opened the generation), on
    // failure, and on close. The worker releases its handle and exits first;
    // only then can an unpublished build be removed (Windows keeps open files).
    const job = worker.job;
    if (job) {
      const published = adopted;
      reclaimHandoff = trackIo(job.afterExit(async () => {
        await removeBuildFilesWithRetry(buildPath);
        if (published !== null && lifetime === token && open?.path === published) scheduleReclaimAfter(paths, published);
      }));
    } else {
      removeBuildFiles(buildPath);
    }
  }
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
    waiting: null,
    pendingOutcome: null,
    deferred: null,
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
function driveFlight(target: Flight, budgetMs: number, mode: DriveMode): boolean {
  if (target.done) return true;
  if (target.running || target.waiting) return false;
  const deadline = performance.now() + budgetMs;
  target.running = true;
  try {
    if (target.deferred) {
      if (mode === "sync") return false;
      const request = target.deferred;
      target.deferred = null;
      startIo(target, request);
      return false;
    }
    for (;;) {
      const observer = stepObserver;
      const phaseBefore = stepPhase;
      const stepStarted = observer ? performance.now() : 0;
      const input = target.pendingOutcome ?? undefined;
      target.pendingOutcome = null;
      let step: IteratorResult<StepYield, Settled>;
      try {
        step = target.steps.next(input);
      } finally {
        if (observer) observer({ phase: phaseBefore === stepPhase ? stepPhase : `${phaseBefore}->${stepPhase}`, startedAt: stepStarted, ms: performance.now() - stepStarted });
      }
      if (step.done) {
        finishFlight(target, { result: step.value });
        return true;
      }
      const request = step.value;
      if (request) {
        if (mode === "async") {
          startIo(target, request);
          return false;
        }
        if (!request.runSync) {
          target.deferred = request;
          return false;
        }
        const ioStarted = observer ? performance.now() : 0;
        target.pendingOutcome = runIoSync(request.runSync);
        if (observer) observer({ phase: request.phase, startedAt: ioStarted, ms: performance.now() - ioStarted });
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

function runIoSync(run: () => void): IoOutcome {
  try {
    run();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Start an async request; its settlement re-arms the timer driver, which delivers the outcome. */
function startIo(target: Flight, request: IoRequest): void {
  target.waiting = request;
  const observer = stepObserver;
  const started = observer ? performance.now() : 0;
  let operation: Promise<void>;
  try {
    operation = request.runAsync();
  } catch (error) {
    operation = Promise.reject(error);
  }
  if (observer) observer({ phase: request.phase, startedAt: started, ms: performance.now() - started });
  operation.then(
    (): IoOutcome => ({ ok: true }),
    (error: unknown): IoOutcome => ({ ok: false, error }),
  ).then(outcome => {
    // A close or a newer flight cleared or replaced the wait: drop the outcome.
    if (target.waiting !== request) return;
    target.waiting = null;
    if (flight !== target || target.done) return;
    target.pendingOutcome = outcome;
    scheduleFlight(target);
  });
}

function scheduleFlight(target: Flight): void {
  if (target.done || target.timer || flight !== target) return;
  target.handedOff = true;
  // Settlement of the pending request re-arms this; no slice runs meanwhile.
  if (target.waiting) return;
  // setTimeout(0), not setImmediate: on Bun 1.4 an in-process HTTP exchange
  // waited ~50 ms per request behind setImmediate-chained slices and ~0.1 ms
  // behind timers. Same yield as the cooperative usage scanner.
  target.timer = setTimeout(() => {
    target.timer = null;
    if (flight !== target || target.done) return;
    if (!driveFlight(target, sliceMs, "async")) scheduleFlight(target);
  }, 0);
}

function openForRead(): Promise<Settled> {
  let target = flight;
  if (!target) {
    target = startFlight(null);
    if (!driveFlight(target, sliceMs, "async")) scheduleFlight(target);
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
  if (!driveFlight(target, syncBudgetMs, "sync")) {
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
    // An I/O request still in flight settles on its own; its outcome is dropped.
    target.waiting = null;
    target.pendingOutcome = null;
    target.deferred = null;
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
  if (!driveFlight(target, sliceMs, "async")) scheduleFlight(target);
  const { meta } = await target.promise;
  // The operator asked for a clean index directory: wait for old files too.
  await reclaimHandoff;
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
/** Rename and warm-up used by publication; tests replace them to hold or fail each one. */
export interface RequestHistoryPublishIo {
  rename: (from: string, to: string) => Promise<void>;
  renameSync: (from: string, to: string) => void;
  warm: (path: string) => Promise<void>;
  /** Opens the published generation; `defaultOpen` is the real open. */
  openGeneration: (path: string, defaultOpen: (path: string) => Database) => Database;
}

const WARM_BYTES = 4096;

/** Open, read the first page and close, so on-access scanning and cold reads finish off the loop. */
async function warmGenerationFile(path: string): Promise<void> {
  const file = await openFileAsync(path, "r");
  try {
    await file.read(Buffer.alloc(WARM_BYTES), 0, WARM_BYTES, 0);
  } finally {
    await file.close();
  }
}

const DEFAULT_PUBLISH_IO: RequestHistoryPublishIo = {
  rename: (from, to) => renameAsync(from, to),
  renameSync: (from, to) => renameSync(from, to),
  warm: warmGenerationFile,
  openGeneration: (path, defaultOpen) => defaultOpen(path),
};
let publishIo: RequestHistoryPublishIo = DEFAULT_PUBLISH_IO;
// Publication I/O that may outlive its flight (a close during a rename or warm).
const detachedIo = new Set<Promise<void>>();

function trackIo(operation: Promise<void>): Promise<void> {
  const settled = operation.then(() => undefined, () => undefined);
  detachedIo.add(settled);
  void settled.then(() => { detachedIo.delete(settled); });
  return settled;
}

/** Yield one I/O request and rethrow its failure inside the generator, so finally blocks and stale restarts run. */
function* awaitIo(request: IoRequest): Generator<StepYield, void, IoOutcome | undefined> {
  const outcome = yield request;
  if (!outcome) throw new Error(`request-history ${request.phase} resumed without an outcome`);
  if (!outcome.ok) throw outcome.error ?? new Error(`request-history ${request.phase} failed`);
}

/** The ledger and the newest generation still match what this publication built. */
function assertPublishable(dir: string, generationPath: string, revision: UsageLogRevision | null): void {
  if (!sameLedger(revision, sourceIdentity())) {
    throw new RequestHistoryIndexStaleError("usage log changed while publishing");
  }
  if (newestGenerationPath(dir) !== generationPath) {
    throw new RequestHistoryIndexStaleError("index generation superseded while publishing");
  }
}

/** Test seam: replace publication I/O (null restores the defaults). */
export function setRequestHistoryPublishIoForTests(io: Partial<RequestHistoryPublishIo> | null): void {
  publishIo = io ? { ...DEFAULT_PUBLISH_IO, ...io } : DEFAULT_PUBLISH_IO;
}

/** Test teardown: wait for publication I/O and deferred cleanup that outlived a closed flight. */
export async function drainRequestHistoryIoForTests(): Promise<void> {
  while (detachedIo.size > 0) await Promise.all([...detachedIo]);
}

/** One generator step as the slice driver ran it, for tests that attribute event-loop gaps. */
export interface RequestHistoryStepSample {
  phase: string;
  startedAt: number;
  ms: number;
}

// Test-only attribution: which part of a refresh a step ran (refresh, tail,
// prepare, ingest, publish-meta, publish-wal, publish-close, publish-open);
// rename and warm-up samples carry their request phase. Plain assignments; no
// cost unless an observer is installed.
let stepPhase = "refresh";
let stepObserver: ((sample: RequestHistoryStepSample) => void) | null = null;

/** Test seam: observe every driven step with its phase and duration; null removes it. */
export function setRequestHistoryStepObserverForTests(observer: ((sample: RequestHistoryStepSample) => void) | null): void {
  stepObserver = observer;
}

export function setRequestHistoryBudgetsForTests(
  budgets: { sliceMs?: number; syncBudgetMs?: number; checkpointRetryMs?: number } | null,
): void {
  sliceMs = budgets?.sliceMs ?? REQUEST_HISTORY_SLICE_MS;
  syncBudgetMs = budgets?.syncBudgetMs ?? REQUEST_HISTORY_SYNC_BUDGET_MS;
  checkpointRetryMs = budgets?.checkpointRetryMs ?? CHECKPOINT_RETRY_MS;
}

/** Where a full rebuild runs: by ledger size (auto), always inline, or always on the worker. */
export type RequestHistoryRebuildWorkerMode = "auto" | "inline" | "worker";

/** Test seam: pin where full rebuilds run; null restores the size rule. */
export function setRequestHistoryRebuildWorkerForTests(mode: RequestHistoryRebuildWorkerMode | null): void {
  rebuildWorkerMode = mode ?? "auto";
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
