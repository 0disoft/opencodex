import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getConfigDir } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { computeRoutingAnalytics } from "../../src/routing/analytics";
import { clearHealthHistoryCacheForTests, healthEvidenceForCandidate } from "../../src/routing/health";
import { ingestSteps } from "../../src/routing/history/ingest";
import { RECLAIM_SERVING_MAX_WAL_BYTES } from "../../src/routing/history/generations";
import {
  closeRequestHistoryIndex,
  drainRequestHistoryIoForTests,
  noteRequestHistoryIndexError,
  openRequestHistoryIndex,
  openRequestHistoryIndexSync,
  queryRequestHistory,
  rebuildRequestHistoryIndex,
  RequestHistoryIndexBusyError,
  RequestHistoryIndexClosedError,
  REQUEST_HISTORY_MAX_RECORD_BYTES,
  setRequestHistoryBudgetsForTests,
} from "../../src/routing/history/indexer";
import { HISTORY_SCHEMA_VERSION, historyIndexDir, historyIndexPath } from "../../src/routing/history/schema";
import { currentUsageLogRevision, resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Contract tests for #6990: the request-history refresh runs in bounded steps
// off the serving event loop. A zero budget makes every drive advance exactly
// one step, so cancellation and resume are exercised at known boundaries.

let testDir = "";
let previousHome: string | undefined;
const now = Date.now();

function line(index: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    requestId: `r-${index}`,
    timestamp: now - 60_000 - index,
    provider: index % 2 === 0 ? "b" : "a",
    model: index % 2 === 0 ? "m2" : "m1",
    status: index % 11 === 0 ? 500 : 200,
    durationMs: 100 + (index % 900),
    usageStatus: "reported",
    usage: { inputTokens: 1000, outputTokens: 200 },
    totalTokens: 1200,
    surface: "codex",
    conversationId: `c-${index % 50}`,
    ...overrides,
  });
}

function writeLedger(lines: string[]): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(usageLogPath(), `${lines.join("\n")}\n`);
}

function rowsFor(count: number): string[] {
  return Array.from({ length: count }, (_, index) => line(index));
}

function dump(dbPath: string): { rows: unknown[]; meta: Record<string, string>; lastError: string | undefined } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT * FROM requests ORDER BY request_id").all();
    const pairs = db.query("SELECT key, value FROM schema_meta").all() as Array<{ key: string; value: string }>;
    const meta = Object.fromEntries(pairs
      .filter(pair => pair.key !== "built_at_ms" && pair.key !== "last_error")
      .map(pair => [pair.key, pair.value]));
    return { rows, meta, lastError: pairs.find(pair => pair.key === "last_error")?.value };
  } finally {
    db.close();
  }
}

function indexFiles(): string[] {
  const dir = historyIndexDir(getConfigDir());
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** One timer turn; with zero budgets the background driver advances one step per turn. */
function turn(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-history-off-loop-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  clearHealthHistoryCacheForTests();
  closeRequestHistoryIndex();
});

afterEach(async () => {
  closeRequestHistoryIndex();
  await drainRequestHistoryIoForTests();
  setRequestHistoryBudgetsForTests(null);
  clearHealthHistoryCacheForTests();
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(testDir);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("request-history refresh off the event loop (#6990)", () => {
  test("the routing-time sync entry hands a rebuild to the background and reports busy", async () => {
    writeLedger(rowsFor(3000));
    setRequestHistoryBudgetsForTests({ sliceMs: 0, syncBudgetMs: 0 });

    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    // A second routing decision does not spend another budget on the same work.
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    // Routing maps busy to unknown evidence instead of waiting for the rebuild.
    expect(healthEvidenceForCandidate({ provider: "a", model: "m1", now }).sampleCount).toBeUndefined();

    const meta = await openRequestHistoryIndex();
    expect(meta.indexedRows).toBe(3000);
    expect(meta.lastError).toBe("index missing; built from usage ledger");
    // The unknown result cached during the rebuild expires with it, not after the TTL.
    expect(healthEvidenceForCandidate({ provider: "a", model: "m1", now }).sampleCount).toBeGreaterThan(0);
    expect(openRequestHistoryIndexSync().indexedRows).toBe(3000);
  });

  test("close cancels a rebuild in flight and removes its private build", async () => {
    writeLedger(rowsFor(3000));
    setRequestHistoryBudgetsForTests({ sliceMs: 0, syncBudgetMs: 0 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
      expect(indexFiles().some(name => name.startsWith("b"))).toBe(true);
      const waiter = openRequestHistoryIndex();
      closeRequestHistoryIndex();
      await expect(waiter).rejects.toBeInstanceOf(RequestHistoryIndexClosedError);

      // A sync-started flight with no awaiters is cancelled without an unhandled rejection.
      expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
      closeRequestHistoryIndex();
      for (let index = 0; index < 5; index++) await turn();
      expect(indexFiles()).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    const meta = await openRequestHistoryIndex();
    expect(meta.indexedRows).toBe(3000);
  });

  test("an interrupted tail resumes exactly at its last committed line", async () => {
    writeLedger(rowsFor(200));
    const first = await openRequestHistoryIndex();
    expect(first.indexedRows).toBe(200);
    appendFileSync(usageLogPath(), `${Array.from({ length: 4000 }, (_, index) => line(1000 + index)).join("\n")}\n`);

    setRequestHistoryBudgetsForTests({ sliceMs: 0, syncBudgetMs: 0 });
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    for (let index = 0; index < 12; index++) await turn();
    closeRequestHistoryIndex();

    const ledger = readFileSync(usageLogPath());
    const partial = dump(first.dbPath);
    const offset = Number(partial.meta.indexed_offset);
    expect(offset).toBeGreaterThan(first.indexedOffset);
    expect(offset).toBeLessThan(ledger.length);
    expect(ledger[offset - 1]).toBe(0x0a);
    // Rows and checkpoint committed together: every committed line, nothing past it.
    const committedLines = ledger.subarray(0, offset).toString("utf-8").split("\n").filter(Boolean).length;
    expect(partial.rows.length).toBe(committedLines);
    expect(Number(partial.meta.indexed_rows)).toBe(committedLines);

    setRequestHistoryBudgetsForTests(null);
    const resumed = await openRequestHistoryIndex();
    expect(resumed.dbPath).toBe(first.dbPath);
    expect(resumed.indexedRows).toBe(4200);
    expect(dump(resumed.dbPath).rows.length).toBe(4200);
  });

  test("a full rebuild produces the same index as incremental ingest", async () => {
    const parts = [
      line(1),
      line(2),
      line(1, { status: 404 }), // duplicate request id: the first row wins
      "{not json",
      JSON.stringify({ requestId: "missing-fields" }),
      line(3, { requestedModel: `policy/${"long-selector".repeat(40)}` }),
      line(4, {
        attempts: [
          { provider: "a", model: "m1", status: 500, durationMs: 5 },
          { provider: "b", model: "m2", status: 200, durationMs: 7 },
        ],
        routeDecision: { routeKind: "policy", profile: { id: "healthy", revision: "r1" } },
      }),
      `${line(5)}\r`,
      line(6, { pad: "y".repeat(REQUEST_HISTORY_MAX_RECORD_BYTES + 16) }), // oversized: skipped
      line(7, { conversationId: "대화-✓" }),
      ...Array.from({ length: 1500 }, (_, index) => line(100 + index)),
    ];
    const ledger = Buffer.from(`${parts.join("\n")}\n${line(9999).slice(0, 40)}`);
    mkdirSync(getConfigDir(), { recursive: true });
    let written = 0;
    let meta = null as Awaited<ReturnType<typeof openRequestHistoryIndex>> | null;
    // Cuts land mid-line, so each refresh also exercises the partial-line boundary.
    for (const fraction of [0.2, 0.5, 0.77, 1]) {
      const cut = Math.floor(ledger.length * fraction);
      appendFileSync(usageLogPath(), ledger.subarray(written, cut));
      written = cut;
      meta = await openRequestHistoryIndex();
    }
    const incremental = dump(meta!.dbPath);
    // 1500 bulk rows plus r-1..r-5 and r-7; the duplicate, malformed, incomplete,
    // oversized and unterminated lines contribute nothing.
    expect(incremental.rows.length).toBe(1506);
    expect(Number(incremental.meta.indexed_rows)).toBe(1506);
    expect(Number(incremental.meta.indexed_offset)).toBe(ledger.lastIndexOf(0x0a) + 1);

    const rebuilt = await rebuildRequestHistoryIndex();
    expect(rebuilt.dbPath).not.toBe(meta!.dbPath);
    const full = dump(rebuilt.dbPath);
    expect(full.rows).toEqual(incremental.rows);
    expect(full.meta).toEqual(incremental.meta);
    expect(full.lastError).toBe("manual rebuild requested");
  });

  test("a rebuild keeps the specific reason that triggered it", async () => {
    writeLedger(rowsFor(10));
    const first = await openRequestHistoryIndex();
    closeRequestHistoryIndex();
    const db = new Database(first.dbPath);
    db.query("UPDATE schema_meta SET value = '1' WHERE key = 'schema_version'").run();
    db.close();
    const rebuilt = await openRequestHistoryIndex();
    expect(rebuilt.lastError).toBe(`schema version 1 -> ${HISTORY_SCHEMA_VERSION}; index rebuilt`);
    expect(rebuilt.indexedRows).toBe(10);
  });

  test("corruption reported by a reader rebuilds the index on the next refresh", async () => {
    writeLedger(rowsFor(10));
    await openRequestHistoryIndex();
    noteRequestHistoryIndexError(Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }));
    const rebuilt = await openRequestHistoryIndex();
    expect(rebuilt.lastError).toBe("integrity error; index rebuilt");
    expect(rebuilt.indexedRows).toBe(10);
    // Busy is transient: it never schedules a rebuild.
    noteRequestHistoryIndexError(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
    expect((await openRequestHistoryIndex()).lastError).toBe("integrity error; index rebuilt");
  });

  test("a generation published by another process replaces the open one", async () => {
    writeLedger(rowsFor(20));
    const first = await openRequestHistoryIndex();
    const child = Bun.spawnSync({
      cmd: [process.execPath, "-e", `const m = await import(${JSON.stringify(join(import.meta.dir, "../../src/routing/history/indexer.ts"))}); const meta = await m.rebuildRequestHistoryIndex(); m.closeRequestHistoryIndex(); console.log(meta.dbPath);`],
      env: { ...process.env, OPENCODEX_HOME: testDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const published = child.stdout.toString().trim();
    expect(published).not.toBe(first.dbPath);

    const next = await openRequestHistoryIndex();
    expect(next.dbPath).toBe(published);
    expect(next.lastError).toBe("manual rebuild requested");
    expect(next.indexedRows).toBe(20);
  });

  test("the pre-generation single-file index is removed once a generation publishes", async () => {
    writeLedger(rowsFor(5));
    const legacy = historyIndexPath(getConfigDir());
    writeFileSync(legacy, "old index");
    writeFileSync(`${legacy}-wal`, "old wal");
    const meta = await openRequestHistoryIndex();
    expect(dirname(meta.dbPath)).toBe(historyIndexDir(getConfigDir()));
    // Reclamation runs after the refresh settles, one file per timer turn.
    for (let index = 0; index < 3; index++) await turn();
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}-wal`)).toBe(false);
  });
});


describe("request-history generations and readers (#6990 review)", () => {
  test("an older generation another connection still reads survives until it is released", async () => {
    writeLedger(rowsFor(40));
    const first = await openRequestHistoryIndex();
    const reader = new Database(first.dbPath, { readonly: true });
    try {
      reader.exec("BEGIN");
      expect((reader.query("SELECT count(*) AS n FROM requests").get() as { n: number }).n).toBe(40);
      const second = await rebuildRequestHistoryIndex();
      expect(second.dbPath).not.toBe(first.dbPath);
      // The reader's files were left alone, so its snapshot keeps working.
      expect(existsSync(first.dbPath)).toBe(true);
      expect((reader.query("SELECT count(*) AS n FROM requests").get() as { n: number }).n).toBe(40);
      reader.exec("COMMIT");
    } finally {
      reader.close();
    }
    const third = await rebuildRequestHistoryIndex();
    expect(existsSync(first.dbPath)).toBe(false);
    expect(indexFiles().filter(name => name.endsWith(".sqlite"))).toEqual([basename(third.dbPath)]);
  });

  test("a read that resumes after a rebuild started reads the published generation", async () => {
    writeLedger(rowsFor(30));
    await openRequestHistoryIndex();
    // Both reads have a settled refresh but resume only after the rebuild below
    // has closed that refresh's handle.
    const page = queryRequestHistory({}, undefined, 100);
    const analytics = computeRoutingAnalytics({});
    const rebuilt = rebuildRequestHistoryIndex();
    expect((await page).rows.length).toBe(30);
    expect((await page).meta.dbPath).toBe((await rebuilt).dbPath);
    expect((await analytics).historyTruncated).toBe(false);
  });

  test("a manual rebuild queued behind a refresh is cancelled by close", async () => {
    writeLedger(rowsFor(3000));
    setRequestHistoryBudgetsForTests({ sliceMs: 0, syncBudgetMs: 0 });
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    const manual = rebuildRequestHistoryIndex();
    closeRequestHistoryIndex();
    await expect(manual).rejects.toBeInstanceOf(RequestHistoryIndexClosedError);
    for (let index = 0; index < 5; index++) await turn();
    expect(indexFiles()).toEqual([]);
  });

  test("known health evidence stops being served from cache once a rebuild starts", async () => {
    writeLedger(rowsFor(40));
    await openRequestHistoryIndex();
    expect(healthEvidenceForCandidate({ provider: "a", model: "m1", now }).sampleCount).toBeGreaterThan(0);
    // Replace the ledger (new file, as retention does) with rows for "b" only,
    // large enough that its rebuild spans several steps.
    const replacement = `${usageLogPath()}.next`;
    writeFileSync(replacement, `${Array.from({ length: 3000 }, (_, index) => line(2 * index)).join("\n")}\n`);
    renameSync(replacement, usageLogPath());
    setRequestHistoryBudgetsForTests({ sliceMs: 0, syncBudgetMs: 0 });
    expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
    // Within the cache TTL, yet the old ledger's evidence is no longer served.
    expect(healthEvidenceForCandidate({ provider: "a", model: "m1", now }).sampleCount).toBeUndefined();
    await openRequestHistoryIndex();
    expect(healthEvidenceForCandidate({ provider: "a", model: "m1", now }).sampleCount).toBeUndefined();
    expect(healthEvidenceForCandidate({ provider: "b", model: "m2", now }).sampleCount).toBeGreaterThan(0);
  });

  test("overlapping tails from two connections keep counts and source metadata moving forward", async () => {
    writeLedger(rowsFor(50));
    const built = await openRequestHistoryIndex();
    closeRequestHistoryIndex();
    appendFileSync(usageLogPath(), `${Array.from({ length: 1000 }, (_, index) => line(1000 + index)).join("\n")}\n`);
    const revision = currentUsageLogRevision()!;
    const older = new Database(built.dbPath);
    const newer = new Database(built.dbPath);
    try {
      const slow = ingestSteps(older, usageLogPath(), built.indexedOffset, { expected: revision });
      expect(slow.next().done).toBe(false); // suspended after its first chunk
      appendFileSync(usageLogPath(), `${Array.from({ length: 300 }, (_, index) => line(5000 + index)).join("\n")}\n`);
      const fast = ingestSteps(newer, usageLogPath(), built.indexedOffset, { expected: revision });
      while (!fast.next().done) { /* drain */ }
      while (!slow.next().done) { /* drain */ }
    } finally {
      older.close();
      newer.close();
    }
    const size = readFileSync(usageLogPath()).length;
    const after = dump(built.dbPath);
    expect(after.rows.length).toBe(1350);
    expect(Number(after.meta.indexed_rows)).toBe(1350);
    expect(Number(after.meta.indexed_offset)).toBe(size);
    expect(Number(after.meta.source_size)).toBe(size);
  });
});


test("a serving refresh leaves an old index with a large WAL for a manual rebuild", async () => {
  writeLedger(rowsFor(5));
  // A pre-generation index left with a hot WAL above the serving checkpoint bound.
  const legacy = historyIndexPath(getConfigDir());
  const source = `${legacy}.source`;
  const writer = new Database(source, { create: true });
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  writer.exec("CREATE TABLE filler (payload BLOB)");
  const insert = writer.query("INSERT INTO filler VALUES (?)");
  writer.transaction(() => {
    for (let index = 0; index < 160; index++) insert.run(Buffer.alloc(64 * 1024, index));
  })();
  copyFileSync(source, legacy);
  copyFileSync(`${source}-wal`, `${legacy}-wal`);
  writer.close();
  expect(statSync(`${legacy}-wal`).size).toBeGreaterThan(RECLAIM_SERVING_MAX_WAL_BYTES);

  const startedAt = performance.now();
  await openRequestHistoryIndex();
  // Checkpointing that WAL would have been one unbounded statement on the serving loop.
  expect(performance.now() - startedAt).toBeLessThan(250);
  expect(existsSync(legacy)).toBe(true);

  await rebuildRequestHistoryIndex();
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(`${legacy}-wal`)).toBe(false);
});


test("superseded generations are reclaimed one per timer turn after the refresh settles", async () => {
  writeLedger(rowsFor(5));
  const first = await openRequestHistoryIndex();
  const dir = historyIndexDir(getConfigDir());
  // Older generations retained by earlier runs (ids sort below the live one).
  const retained = Array.from({ length: 6 }, (_, index) => join(dir, `g${String(index + 1).padStart(15, "0")}-1-${index}.sqlite`));
  for (const path of retained) copyFileSync(first.dbPath, path);
  // A serving-path rebuild publishes a new generation and queues the rest.
  noteRequestHistoryIndexError(Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }));
  const rebuilt = await openRequestHistoryIndex();
  const older = [...retained, first.dbPath];
  expect(older.every(path => existsSync(path))).toBe(true);
  await turn();
  expect(older.filter(path => existsSync(path)).length).toBe(older.length - 1);
  for (let index = 0; index < older.length + 2; index++) await turn();
  expect(older.filter(path => existsSync(path))).toEqual([]);
  expect(existsSync(rebuilt.dbPath)).toBe(true);
});


test("large records commit in byte-bounded batches, not one transaction per 500 rows", async () => {
  writeLedger(rowsFor(10));
  const first = await openRequestHistoryIndex();
  // Each record is accepted (under the 1 MiB record bound) but large.
  const big = (index: number) => line(20_000 + index, { pad: "x".repeat(900 * 1024) });
  appendFileSync(usageLogPath(), `${Array.from({ length: 24 }, (_, index) => big(index)).join("\n")}\n`);
  setRequestHistoryBudgetsForTests({ sliceMs: 0, syncBudgetMs: 0 });
  expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
  // ~120 chunks of 64 KiB: well past the byte cap, far below 500 rows.
  for (let index = 0; index < 120; index++) await turn();
  closeRequestHistoryIndex();
  const partial = dump(first.dbPath);
  expect(Number(partial.meta.indexed_offset)).toBeGreaterThan(first.indexedOffset);
  expect(Number(partial.meta.indexed_rows)).toBeGreaterThan(10);
  expect(Number(partial.meta.indexed_rows)).toBeLessThan(34);
  expect(partial.rows.length).toBe(Number(partial.meta.indexed_rows));

  setRequestHistoryBudgetsForTests(null);
  expect((await openRequestHistoryIndex()).indexedRows).toBe(34);
});


test("a superseded generation with a large pinned WAL is parked, not checkpointed on the serving loop", async () => {
  writeLedger(rowsFor(10));
  const first = await openRequestHistoryIndex();
  // A reader elsewhere holds a snapshot, so tail commits cannot be checkpointed.
  const reader = new Database(first.dbPath, { readonly: true });
  reader.exec("BEGIN");
  reader.query("SELECT count(*) FROM requests").get();
  appendFileSync(usageLogPath(), `${Array.from({ length: 14 }, (_, index) => line(30_000 + index, { pad: "w".repeat(900 * 1024) })).join("\n")}\n`);
  expect((await openRequestHistoryIndex()).indexedRows).toBe(24);
  reader.exec("COMMIT");
  reader.close();
  expect(statSync(`${first.dbPath}-wal`).size).toBeGreaterThan(RECLAIM_SERVING_MAX_WAL_BYTES);

  // Replacing the ledger forces a rebuild; the old generation's handle is retired.
  const replacement = `${usageLogPath()}.next`;
  writeFileSync(replacement, `${rowsFor(3).join("\n")}\n`);
  renameSync(replacement, usageLogPath());
  const rebuilt = await openRequestHistoryIndex();
  expect(rebuilt.indexedRows).toBe(3);
  for (let index = 0; index < 4; index++) await turn();
  // Parked: still open here, so reclamation leaves it alone.
  expect(existsSync(first.dbPath)).toBe(true);

  // Teardown closes the parked handle; the next refresh reclaims the file.
  closeRequestHistoryIndex();
  await openRequestHistoryIndex();
  for (let index = 0; index < 4; index++) await turn();
  expect(existsSync(first.dbPath)).toBe(false);
});
