import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getConfigDir } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { newGenerationNames } from "../../src/routing/history/generations";
import { createBuildDatabase } from "../../src/routing/history/build-file";
import {
  closeRequestHistoryIndex,
  drainRequestHistoryIoForTests,
  openRequestHistoryIndex,
  openRequestHistoryIndexSync,
  rebuildRequestHistoryIndex,
  REQUEST_HISTORY_CHECKPOINT_WAL_BYTES,
  REQUEST_HISTORY_DEFERRED_CLOSE_WAL_BYTES,
  REQUEST_HISTORY_WORKER_MIN_BYTES,
  requestHistoryDb,
  requestHistoryCheckpointStateForTests,
  RequestHistoryIndexBusyError,
  RequestHistoryIndexClosedError,
  setRequestHistoryBudgetsForTests,
  setRequestHistoryRebuildWorkerForTests,
  setRequestHistoryStepObserverForTests,
  withRequestHistoryIndex,
  type RequestHistoryStepSample,
} from "../../src/routing/history/indexer";
import { historyIndexDir } from "../../src/routing/history/schema";
import { resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #6990: a full rebuild of a large ledger runs on a worker thread, so no
// synchronous SQLite open, commit, close or rename of the build lands on the
// serving thread. These pin the worker path's contract against the inline one.

let testDir = "";
let previousHome: string | undefined;

function row(index: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    requestId: `r-${index}`,
    timestamp: 1_790_000_000_000 - index,
    provider: index % 2 === 0 ? "a" : "b",
    model: "m1",
    status: index % 7 === 0 ? 500 : 200,
    durationMs: 10 + (index % 13),
    usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: 2 },
    totalTokens: 12,
    surface: "codex",
    conversationId: `c-${index % 9}`,
    ...extra,
  });
}

function rows(count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, offset) => row(start + offset));
}

function writeLedger(text: string): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(usageLogPath(), text);
}

function indexFiles(prefix: "b" | "g"): string[] {
  const dir = historyIndexDir(getConfigDir());
  return existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith(".sqlite")) : [];
}

function observePhases(): string[] {
  const phases: string[] = [];
  setRequestHistoryStepObserverForTests((sample: RequestHistoryStepSample) => { phases.push(sample.phase); });
  return phases;
}

const turn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** WAL header salts (bytes 16-23): a WAL restart rewrites them. */
function walSalt(dbPath: string): string {
  const header = readFileSync(`${dbPath}-wal`).subarray(16, 24);
  return header.toString("hex");
}

function dump(handle: Database): { rows: unknown[]; meta: Record<string, string> } {
  const tableRows = handle.query("SELECT * FROM requests ORDER BY request_id").all();
  const meta: Record<string, string> = {};
  for (const entry of handle.query("SELECT key, value FROM schema_meta").all() as Array<{ key: string; value: string }>) {
    if (entry.key !== "built_at_ms") meta[entry.key] = entry.value;
  }
  return { rows: tableRows, meta };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-history-worker-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  closeRequestHistoryIndex();
  setRequestHistoryRebuildWorkerForTests(null);
  setRequestHistoryStepObserverForTests(null);
});

afterEach(async () => {
  closeRequestHistoryIndex();
  await drainRequestHistoryIoForTests();
  setRequestHistoryRebuildWorkerForTests(null);
  setRequestHistoryBudgetsForTests(null);
  setRequestHistoryStepObserverForTests(null);
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(testDir);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(testDir);
});

describe("request-history rebuild worker", () => {
  test("a ledger above the size rule builds on the worker with the same rows and meta as the inline build", async () => {
    // Edge cases: duplicates (first payload wins), blank, malformed and CRLF
    // lines, unicode, a record over the 1 MiB cap, and an unterminated tail.
    const lines = [
      ...rows(3000),
      row(5, { model: "duplicate-must-not-win" }),
      "",
      "{not json",
      `${row(3001, { model: "crlf" })}\r`,
      row(3002, { conversationId: "유니코드-✨" }),
      row(3003, { pad: "x".repeat(1024 * 1024 + 10) }),
      row(3004),
    ];
    writeLedger(`${lines.join("\n")}\n${row(3005)}`);
    const phases = observePhases();

    setRequestHistoryRebuildWorkerForTests("inline");
    await rebuildRequestHistoryIndex();
    const inline = await withRequestHistoryIndex(handle => dump(handle));
    expect(phases).not.toContain("worker-build");

    closeRequestHistoryIndex();
    await drainRequestHistoryIoForTests();
    phases.length = 0;
    setRequestHistoryRebuildWorkerForTests(null);
    const meta = await rebuildRequestHistoryIndex();
    const worker = await withRequestHistoryIndex(handle => dump(handle));

    expect(Number(meta.sourceSize)).toBeGreaterThanOrEqual(REQUEST_HISTORY_WORKER_MIN_BYTES);
    expect(phases).toContain("worker-build");
    // No ledger chunk was ingested on the serving thread.
    expect(phases.filter(phase => phase.includes("ingest"))).toEqual([]);
    expect(worker.rows.length).toBe(3003);
    expect(worker).toEqual(inline);
    expect(meta.indexedRows).toBe(3003);
    expect(indexFiles("b")).toEqual([]);
  });

  test("the routing-time sync entry hands a worker rebuild off as busy, then reads the published index", async () => {
    setRequestHistoryRebuildWorkerForTests("worker");
    writeLedger(`${rows(200).join("\n")}\n`);
    const phases = observePhases();

    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    // The worker request is never run by the sync driver.
    expect(phases).not.toContain("worker-build");
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);

    const meta = await openRequestHistoryIndex();
    expect(meta.indexedRows).toBe(200);
    expect(phases).toContain("worker-build");
    expect(openRequestHistoryIndexSync().indexedRows).toBe(200);
  });

  test("close during a worker build rejects readers and leaves no build or generation behind", async () => {
    setRequestHistoryRebuildWorkerForTests("worker");
    writeLedger(`${rows(20_000).join("\n")}\n`);
    const phases = observePhases();

    const read = openRequestHistoryIndex();
    const outcome = read.then(() => null, (error: unknown) => error);
    expect(phases).toContain("worker-hold");
    closeRequestHistoryIndex();
    expect(await outcome).toBeInstanceOf(RequestHistoryIndexClosedError);

    await drainRequestHistoryIoForTests();
    expect(indexFiles("b")).toEqual([]);
    expect(indexFiles("g")).toEqual([]);

    const reopened = await openRequestHistoryIndex();
    expect(reopened.indexedRows).toBe(20_000);
  });

  test("the worker indexes the snapshot its refresh recorded; later appends arrive as a tail", async () => {
    setRequestHistoryRebuildWorkerForTests("worker");
    writeLedger(`${rows(50).join("\n")}\n`);

    const first = openRequestHistoryIndex();
    appendFileSync(usageLogPath(), `${rows(5, 50).join("\n")}\n`);
    expect((await first).indexedRows).toBe(50);

    const second = await openRequestHistoryIndex();
    expect(second.indexedRows).toBe(55);
  });

  test("a ledger replaced before the worker reads it restarts the refresh on the new ledger", async () => {
    setRequestHistoryRebuildWorkerForTests("worker");
    writeLedger(`${rows(40).join("\n")}\n`);
    const phases = observePhases();

    const read = openRequestHistoryIndex();
    expect(phases).toContain("worker-hold");
    const replacement = join(getConfigDir(), "usage.replacement.jsonl");
    writeFileSync(replacement, `${rows(7, 1000).join("\n")}\n`);
    renameSync(replacement, usageLogPath());

    const meta = await read;
    expect(meta.indexedRows).toBe(7);
    const ids = await withRequestHistoryIndex(handle =>
      (handle.query("SELECT request_id FROM requests ORDER BY request_id").all() as Array<{ request_id: string }>).map(entry => entry.request_id));
    expect(ids).toEqual(rows(7, 1000).map(line => (JSON.parse(line) as { requestId: string }).requestId).sort());
    expect(phases.filter(phase => phase === "worker-build").length).toBeGreaterThanOrEqual(2);
    await drainRequestHistoryIoForTests();
    expect(indexFiles("b")).toEqual([]);
  });

  test("a worker rebuild holds the superseded generation and reclaims it once its worker exits", async () => {
    setRequestHistoryRebuildWorkerForTests("worker");
    writeLedger(`${rows(60).join("\n")}\n`);
    const phases = observePhases();
    const first = await openRequestHistoryIndex();
    phases.length = 0;
    const second = await rebuildRequestHistoryIndex();
    expect(second.dbPath).not.toBe(first.dbPath);
    // The worker took the old generation before the serving thread let go of it.
    expect(phases.indexOf("worker-hold")).toBeGreaterThanOrEqual(0);
    expect(phases.indexOf("worker-hold")).toBeLessThan(phases.indexOf("worker-build"));
    // The manual rebuild waits for the handoff, so the old files are gone here.
    expect(existsSync(first.dbPath)).toBe(false);
    expect(indexFiles("g")).toEqual([basename(second.dbPath)]);
    expect(second.indexedRows).toBe(60);
  });

  test("an old generation with unreadable tables does not stop a worker rebuild", async () => {
    setRequestHistoryRebuildWorkerForTests("worker");
    writeLedger(`${rows(100).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    closeRequestHistoryIndex();
    await drainRequestHistoryIoForTests();
    const damage = new Database(first.dbPath, { readwrite: true });
    damage.exec("DROP TABLE schema_meta");
    damage.close();

    const rebuilt = await openRequestHistoryIndex();
    expect(rebuilt.dbPath).not.toBe(first.dbPath);
    expect(rebuilt.indexedRows).toBe(100);
    expect(rebuilt.lastError).toBe("index unreadable; rebuilt");
  });
});

describe("request-history generation names", () => {
  test("a new name sorts above every published generation even when the clock moved back", () => {
    const dir = historyIndexDir(getConfigDir());
    mkdirSync(dir, { recursive: true });
    // An older-format name from a later clock (unpadded pid and sequence).
    writeFileSync(join(dir, "g002000000000000-123-9.sqlite"), "");
    const { generationPath, buildPath } = newGenerationNames(dir, 1_000_000_000_000);
    const name = basename(generationPath);
    expect(name > "g002000000000000-123-9.sqlite").toBe(true);
    expect(name).toMatch(/^g002000000000001-\d{10}-\d{10}\.sqlite$/);
    expect(basename(buildPath)).toBe(`b${name.slice(1)}`);

    writeFileSync(generationPath, "");
    const next = basename(newGenerationNames(dir, 1_000_000_000_000).generationPath);
    expect(next > name).toBe(true);
  });

  test("names taken in the same millisecond still sort in order", () => {
    const dir = historyIndexDir(getConfigDir());
    mkdirSync(dir, { recursive: true });
    const names = Array.from({ length: 12 }, () => basename(newGenerationNames(dir, 1_790_000_000_000).generationPath));
    expect([...names].sort()).toEqual(names);
  });
});

describe("request-history serving-thread I/O", () => {
  test("serving connections never autocheckpoint; an index worker checkpoints a large tail", async () => {
    writeLedger(`${rows(10).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    expect((requestHistoryDb().query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint).toBe(0);
    const sizeBefore = statSync(first.dbPath).size;
    // About 7 MiB of accepted rows: past the checkpoint bound in one tail.
    const big = Array.from({ length: 8 }, (_, index) => row(500 + index, { pad: "p".repeat(900 * 1024) }));
    appendFileSync(usageLogPath(), `${big.join("\n")}\n`);
    const tailed = await openRequestHistoryIndex();
    expect(tailed.indexedRows).toBe(18);
    expect(statSync(`${first.dbPath}-wal`).size).toBeGreaterThanOrEqual(REQUEST_HISTORY_CHECKPOINT_WAL_BYTES);

    await drainRequestHistoryIoForTests();
    // The pages reached the database file, which only a checkpoint does.
    expect(statSync(first.dbPath).size - sizeBefore).toBeGreaterThan(REQUEST_HISTORY_CHECKPOINT_WAL_BYTES);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(18);
  });

  test("a checkpoint a reader held back is retried after the reader lets go", async () => {
    setRequestHistoryBudgetsForTests({ checkpointRetryMs: 20 });
    writeLedger(`${rows(10).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    const sizeBefore = statSync(first.dbPath).size;
    const reader = new Database(first.dbPath, { readonly: true });
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM requests").get();
    const big = Array.from({ length: 8 }, (_, index) => row(700 + index, { pad: "q".repeat(900 * 1024) }));
    appendFileSync(usageLogPath(), `${big.join("\n")}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(18);
    await drainRequestHistoryIoForTests();
    // The pinned snapshot kept the new frames in the WAL.
    expect(statSync(first.dbPath).size - sizeBefore).toBeLessThan(REQUEST_HISTORY_CHECKPOINT_WAL_BYTES);
    reader.exec("COMMIT");
    reader.close();
    // No further tail arrives; the retry alone moves the pages.
    for (let attempt = 0; attempt < 200 && statSync(first.dbPath).size - sizeBefore <= REQUEST_HISTORY_CHECKPOINT_WAL_BYTES; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      await drainRequestHistoryIoForTests();
    }
    expect(statSync(first.dbPath).size - sizeBefore).toBeGreaterThan(REQUEST_HISTORY_CHECKPOINT_WAL_BYTES);
  });

  test("closing with a large WAL detaches at once and checkpoints on a worker", async () => {
    writeLedger(`${rows(10).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    const big = Array.from({ length: 2 }, (_, index) => row(900 + index, { pad: "c".repeat(900 * 1024) }));
    appendFileSync(usageLogPath(), `${big.join("\n")}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(12);
    await drainRequestHistoryIoForTests();
    expect(statSync(`${first.dbPath}-wal`).size).toBeGreaterThanOrEqual(REQUEST_HISTORY_DEFERRED_CLOSE_WAL_BYTES);
    const sizeBefore = statSync(first.dbPath).size;

    closeRequestHistoryIndex();
    // The serving thread checkpointed nothing: the pages are still only in the WAL.
    expect(statSync(first.dbPath).size).toBe(sizeBefore);
    expect(() => requestHistoryDb()).toThrow();

    await drainRequestHistoryIoForTests();
    expect(statSync(first.dbPath).size).toBeGreaterThan(sizeBefore);
    // The last close checkpointed and emptied the WAL (macOS SQLite keeps the empty file).
    expect(existsSync(`${first.dbPath}-wal`) ? statSync(`${first.dbPath}-wal`).size : 0).toBe(0);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(12);
  });

  test("a serving-path close hands any non-empty WAL to a worker", async () => {
    writeLedger(`${rows(10).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    appendFileSync(usageLogPath(), `${rows(20, 10).join("\n")}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(30);
    const walBytes = statSync(`${first.dbPath}-wal`).size;
    expect(walBytes).toBeGreaterThan(0);
    expect(walBytes).toBeLessThan(REQUEST_HISTORY_DEFERRED_CLOSE_WAL_BYTES);
    const sizeBefore = statSync(first.dbPath).size;

    closeRequestHistoryIndex({ checkpointOnWorker: "always" });
    expect(statSync(first.dbPath).size).toBe(sizeBefore);
    await drainRequestHistoryIoForTests();
    expect(existsSync(`${first.dbPath}-wal`) ? statSync(`${first.dbPath}-wal`).size : 0).toBe(0);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(30);
  });

  test("a retry pending for an old generation does not hold back the new generation's checkpoint", async () => {
    // Long enough that the old generation's retry never fires in this test.
    setRequestHistoryBudgetsForTests({ checkpointRetryMs: 60_000 });
    writeLedger(`${rows(10).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    const reader = new Database(first.dbPath, { readonly: true });
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM requests").get();
    const tail = (start: number) => Array.from({ length: 6 }, (_, index) => row(start + index, { pad: "r".repeat(900 * 1024) }));
    appendFileSync(usageLogPath(), `${tail(1000).join("\n")}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(16);
    await drainRequestHistoryIoForTests();
    reader.exec("COMMIT");
    reader.close();

    const rebuilt = await rebuildRequestHistoryIndex();
    expect(rebuilt.dbPath).not.toBe(first.dbPath);
    const sizeBefore = statSync(rebuilt.dbPath).size;
    appendFileSync(usageLogPath(), `${tail(2000).join("\n")}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(22);
    await drainRequestHistoryIoForTests();
    expect(statSync(rebuilt.dbPath).size - sizeBefore).toBeGreaterThan(REQUEST_HISTORY_CHECKPOINT_WAL_BYTES);
  });

  test("a build that fails to initialize removes its private file", () => {
    const dir = historyIndexDir(getConfigDir());
    mkdirSync(dir, { recursive: true });
    const buildPath = join(dir, "b000000000000001-0000000001-0000000001.sqlite");
    writeFileSync(buildPath, "this is not a sqlite database, and it is long enough to have a header".repeat(4));
    expect(() => createBuildDatabase(buildPath, "test", null)).toThrow();
    expect(existsSync(buildPath)).toBe(false);
  });

  test("many small tails keep the WAL bounded: a worker truncates it once it passes the bound", async () => {
    writeLedger(`${rows(10).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    let maxWal = 0;
    // Each tail commits rows, index pages and meta; tiny ledger growth, large WAL growth.
    for (let index = 0; index < 300; index++) {
      appendFileSync(usageLogPath(), `${row(5000 + index)}\n`);
      expect((await openRequestHistoryIndex()).indexedRows).toBe(11 + index);
      maxWal = Math.max(maxWal, existsSync(`${first.dbPath}-wal`) ? statSync(`${first.dbPath}-wal`).size : 0);
    }
    await drainRequestHistoryIoForTests();
    const walAfter = existsSync(`${first.dbPath}-wal`) ? statSync(`${first.dbPath}-wal`).size : 0;
    // Without the size trigger these tails left tens of MB of WAL behind.
    expect(maxWal).toBeLessThan(REQUEST_HISTORY_CHECKPOINT_WAL_BYTES + 512 * 1024);
    expect(walAfter).toBeLessThan(REQUEST_HISTORY_CHECKPOINT_WAL_BYTES);
  }, 60_000);

  test("a tail that arrives during a worker checkpoint waits; the sync entry reports busy", async () => {
    writeLedger(`${rows(10).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    const big = Array.from({ length: 6 }, (_, index) => row(3000 + index, { pad: "k".repeat(900 * 1024) }));
    appendFileSync(usageLogPath(), `${big.join("\n")}\n`);
    const phases = observePhases();
    // This tail passes the bound and starts the checkpoint job.
    expect((await openRequestHistoryIndex()).indexedRows).toBe(16);
    appendFileSync(usageLogPath(), `${row(4000)}\n`);
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(17);
    expect(phases).toContain("checkpoint-wait");
    await drainRequestHistoryIoForTests();
    // The checkpoint moved the tail into the database file and emptied the WAL.
    expect(statSync(first.dbPath).size).toBeGreaterThan(REQUEST_HISTORY_CHECKPOINT_WAL_BYTES);
    expect(statSync(`${first.dbPath}-wal`).size).toBeLessThan(64 * 1024);
    // The worker restarted the WAL; the next serving tail appends to it.
    const salt = walSalt(first.dbPath);
    appendFileSync(usageLogPath(), `${row(4001)}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(18);
    expect(walSalt(first.dbPath)).toBe(salt);
  });

  test("a checkpoint a reader kept from resetting still leaves the restart to the worker", async () => {
    setRequestHistoryBudgetsForTests({ checkpointRetryMs: 60_000 });
    writeLedger(`${rows(10).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    const big = Array.from({ length: 6 }, (_, index) => row(6000 + index, { pad: "z".repeat(900 * 1024) }));
    appendFileSync(usageLogPath(), `${big.join("\n")}\n`);
    // A reader that has seen every frame: the checkpoint backfills them all but cannot reset the WAL.
    const reader = new Database(first.dbPath, { readonly: true });
    expect((await openRequestHistoryIndex()).indexedRows).toBe(16);
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM requests").get();
    await drainRequestHistoryIoForTests();
    reader.exec("COMMIT");
    reader.close();
    const salt = walSalt(first.dbPath);
    appendFileSync(usageLogPath(), `${row(6100)}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(17);
    expect(walSalt(first.dbPath)).toBe(salt);
  });

  test("a generation published by the worker reaches the serving thread with its WAL already started", async () => {
    setRequestHistoryRebuildWorkerForTests("worker");
    writeLedger(`${rows(40).join("\n")}\n`);
    const meta = await openRequestHistoryIndex();
    expect(statSync(`${meta.dbPath}-wal`).size).toBeGreaterThan(0);
    const salt = walSalt(meta.dbPath);
    appendFileSync(usageLogPath(), `${row(7000)}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(41);
    expect(walSalt(meta.dbPath)).toBe(salt);
  });

  test("a checkpoint retry never starts while a tail is still writing", async () => {
    setRequestHistoryBudgetsForTests({ checkpointRetryMs: 20 });
    writeLedger(`${rows(10).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    const reader = new Database(first.dbPath, { readonly: true });
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM requests").get();
    const big = (start: number) => Array.from({ length: 6 }, (_, index) => row(start + index, { pad: "t".repeat(900 * 1024) }));
    appendFileSync(usageLogPath(), `${big(8000).join("\n")}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(16);
    // Wait for the held-back checkpoint to finish and arm its retry.
    for (let index = 0; index < 2000 && !(requestHistoryCheckpointStateForTests().running === null && requestHistoryCheckpointStateForTests().retryPending); index++) await turn();
    expect(requestHistoryCheckpointStateForTests().retryPending).toBe(true);

    // A tail spread over many steps; the retry timer fires while it runs.
    setRequestHistoryBudgetsForTests({ checkpointRetryMs: 20, sliceMs: 0 });
    appendFileSync(usageLogPath(), `${big(9000).join("\n")}\n`);
    let settled = false;
    const tail = openRequestHistoryIndex().finally(() => { settled = true; });
    let startedDuringTail = false;
    while (!settled) {
      if (requestHistoryCheckpointStateForTests().running !== null) startedDuringTail = true;
      await turn();
    }
    expect((await tail).indexedRows).toBe(22);
    expect(startedDuringTail).toBe(false);
    reader.exec("COMMIT");
    reader.close();
  }, 30_000);

  test("a checkpoint that finishes after close leaves no retry state for the reopened index", async () => {
    setRequestHistoryBudgetsForTests({ checkpointRetryMs: 60_000 });
    writeLedger(`${rows(10).join("\n")}\n`);
    const first = await openRequestHistoryIndex();
    const reader = new Database(first.dbPath, { readonly: true });
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM requests").get();
    const big = (start: number) => Array.from({ length: 6 }, (_, index) => row(start + index, { pad: "u".repeat(900 * 1024) }));
    appendFileSync(usageLogPath(), `${big(10_000).join("\n")}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(16);
    expect(requestHistoryCheckpointStateForTests().running).toBe(first.dbPath);
    // Close while the held-back checkpoint runs, then reopen the same generation.
    closeRequestHistoryIndex();
    expect((await openRequestHistoryIndex()).dbPath).toBe(first.dbPath);
    await drainRequestHistoryIoForTests();
    expect(requestHistoryCheckpointStateForTests().retryPending).toBe(false);
    reader.exec("COMMIT");
    reader.close();

    const sizeBefore = statSync(first.dbPath).size;
    appendFileSync(usageLogPath(), `${big(11_000).join("\n")}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(22);
    await drainRequestHistoryIoForTests();
    expect(statSync(first.dbPath).size - sizeBefore).toBeGreaterThan(REQUEST_HISTORY_CHECKPOINT_WAL_BYTES);
  });

  test("a new generation's checkpoint requested during an old generation's job runs after it", async () => {
    // The old job waits on a reader for up to 4 s, so the overlap below is certain.
    setRequestHistoryBudgetsForTests({ checkpointRetryMs: 60_000, checkpointBusyTimeoutMs: 4_000 });
    setRequestHistoryRebuildWorkerForTests("inline");
    writeLedger(`${rows(10).join("\n")}\n`);
    const a = await openRequestHistoryIndex();
    const reader = new Database(a.dbPath, { readonly: true });
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM requests").get();
    const big = (start: number) => Array.from({ length: 6 }, (_, index) => row(start + index, { pad: "v".repeat(900 * 1024) }));
    appendFileSync(usageLogPath(), `${big(12_000).join("\n")}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(16);
    expect(requestHistoryCheckpointStateForTests().running).toBe(a.dbPath);

    // A replaced ledger publishes generation B, whose tail then passes the bound.
    const replacement = join(getConfigDir(), "usage.replacement.jsonl");
    writeFileSync(replacement, `${rows(5, 20_000).join("\n")}\n`);
    renameSync(replacement, usageLogPath());
    const b = await openRequestHistoryIndex();
    expect(b.dbPath).not.toBe(a.dbPath);
    appendFileSync(usageLogPath(), `${big(13_000).join("\n")}\n`);
    expect((await openRequestHistoryIndex()).indexedRows).toBe(11);
    expect(requestHistoryCheckpointStateForTests().running).toBe(a.dbPath);
    const sizeBefore = statSync(b.dbPath).size;

    reader.exec("COMMIT");
    reader.close();
    for (let attempt = 0; attempt < 400 && statSync(b.dbPath).size - sizeBefore <= REQUEST_HISTORY_CHECKPOINT_WAL_BYTES; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await drainRequestHistoryIoForTests();
    }
    expect(statSync(b.dbPath).size - sizeBefore).toBeGreaterThan(REQUEST_HISTORY_CHECKPOINT_WAL_BYTES);
  }, 30_000);
});
