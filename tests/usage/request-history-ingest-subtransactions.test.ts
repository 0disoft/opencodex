import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import {
  ingestSteps, isSqliteBusy, nextCommitRowLimit, RequestHistoryIndexStaleError,
  REQUEST_HISTORY_COMMIT_TARGET_MS, REQUEST_HISTORY_INITIAL_COMMIT_ROWS,
  REQUEST_HISTORY_INSERT_BATCH, REQUEST_HISTORY_MAX_RECORD_BYTES, REQUEST_HISTORY_MIN_COMMIT_ROWS,
} from "../../src/routing/history/ingest";
import { drainRequestHistoryIoForTests,
  closeRequestHistoryIndex, openRequestHistoryIndex, rebuildRequestHistoryIndex,
  RequestHistoryIndexClosedError, setRequestHistoryBudgetsForTests,
} from "../../src/routing/history/indexer";
import { HISTORY_DDL, HISTORY_META_KEYS, historyIndexDir } from "../../src/routing/history/schema";
import { resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const BUILT_AT = 1_700_000_000_000;
const SENTINELS = { source_size: "-11", source_mtime_ms: "-12", built_at_ms: "-13" };
type Steps = ReturnType<typeof ingestSteps>;
type Payload = { request_id: string; row_json: string };
let dir: string;
let previousHome: string | undefined;
let restoreDate: () => void;
let handles: Database[];
let generators: Steps[];

function line(index: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    requestId: `r-${index}`, timestamp: BUILT_AT - index, provider: "a", model: "m1",
    status: 200, durationMs: 100, usageStatus: "reported", ...overrides,
  });
}

function lines(count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, index) => line(start + index));
}

function ledger(parts: string[], suffix = "", name = "usage.jsonl"): string {
  const path = join(dir, name);
  writeFileSync(path, `${parts.length ? `${parts.join("\n")}\n` : ""}${suffix}`);
  return path;
}

function database(mode: "MEMORY" | "WAL", name = "index.sqlite"): Database {
  const db = new Database(join(dir, name), { create: true, readwrite: true });
  handles.push(db);
  db.exec(`PRAGMA journal_mode = ${mode}`);
  if (mode === "MEMORY") db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA busy_timeout = 0");
  db.exec(HISTORY_DDL);
  for (const [key, value] of Object.entries({ ...SENTINELS, indexed_offset: "0", indexed_rows: "0" })) {
    db.query("INSERT INTO schema_meta VALUES (?, ?)").run(key, value);
  }
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: mode.toLowerCase() });
  if (mode === "MEMORY") expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 0 });
  return db;
}

function meta(db: Database): Record<string, string> {
  const pairs = db.query("SELECT key, value FROM schema_meta ORDER BY key").all() as { key: string; value: string }[];
  return Object.fromEntries(pairs.map(({ key, value }) => [key, value]));
}

function payloads(db: Database): Payload[] {
  return db.query("SELECT request_id, row_json FROM requests ORDER BY request_id").all() as Payload[];
}

function expectedPayloads(parts: string[]): Payload[] {
  const first = new Map<string, Payload>();
  for (const part of parts) {
    const entry = JSON.parse(part) as { requestId: string };
    if (!first.has(entry.requestId)) first.set(entry.requestId, { request_id: entry.requestId, row_json: JSON.stringify(entry) });
  }
  return [...first.values()].sort((a, b) => a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0);
}

function assertRows(db: Database, parts: string[]): void {
  const expected = expectedPayloads(parts);
  expect(payloads(db)).toEqual(expected);
  expect(Number(meta(db).indexed_rows)).toBe(expected.length);
}

/** Two clock reads per successful transaction; explicit costs, never real time. */
function clock(costs: number[] = []): () => number {
  let time = 0;
  let calls = 0;
  return () => {
    if (calls % 2 === 1) time += costs[Math.floor(calls / 2)] ?? 1;
    calls++;
    return time;
  };
}

function steps(db: Database, path: string, from = 0, options: { now?: () => number; beforeWrite?: () => void } = {}): Steps {
  const generator = ingestSteps(db, path, from, { expected: statSync(path), now: clock(), ...options });
  generators.push(generator);
  return generator;
}

function finish(generator: Steps): number {
  for (let index = 0; index < 10_000; index++) {
    const result = generator.next();
    if (result.done) return result.value;
  }
  throw new Error("ingest did not terminate in 10,000 steps");
}

/** Read-chunk yields are not commits; locate the next changed durable offset. */
function prefix(generator: Steps, db: Database): IteratorResult<void, number> {
  const offset = meta(db).indexed_offset;
  for (let index = 0; index < 10_000; index++) {
    const result = generator.next();
    if (result.done || meta(db).indexed_offset !== offset) return result;
  }
  throw new Error("no committed prefix in 10,000 steps");
}

function rowEnds(parts: string[]): number[] {
  let offset = 0;
  return parts.map(part => offset += Buffer.byteLength(part) + 1);
}

function completionMeta(db: Database): Record<string, string> {
  const stored = meta(db);
  return Object.fromEntries(Object.keys(SENTINELS).map(key => [key, stored[key]!]));
}

function assertComplete(db: Database, path: string, offset = statSync(path).size): void {
  const source = statSync(path);
  expect(meta(db).indexed_offset).toBe(String(offset));
  expect(completionMeta(db)).toEqual({
    source_size: String(source.size), source_mtime_ms: String(source.mtimeMs), built_at_ms: String(BUILT_AT),
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  dir = mkdtempSync(join(tmpdir(), "ocx-history-subtransactions-"));
  process.env.OPENCODEX_HOME = dir;
  handles = [];
  generators = [];
  closeRequestHistoryIndex();
  resetUsageReadCacheForTests();
  const date = spyOn(Date, "now").mockReturnValue(BUILT_AT);
  restoreDate = () => date.mockRestore();
});

afterEach(async () => {
  for (const generator of generators) generator.return(0);
  for (const db of handles.reverse()) db.close();
  closeRequestHistoryIndex();
  await drainRequestHistoryIoForTests();
  setRequestHistoryBudgetsForTests(null);
  restoreDate();
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(dir);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(dir);
});

describe("adaptive commit row limit", () => {
  test("the budget and bounds are the intended 8 ms, 16, 64 and 500", () => {
    expect([REQUEST_HISTORY_COMMIT_TARGET_MS, REQUEST_HISTORY_MIN_COMMIT_ROWS,
      REQUEST_HISTORY_INITIAL_COMMIT_ROWS, REQUEST_HISTORY_INSERT_BATCH]).toEqual([8, 16, 64, 500]);
  });
  const cases = [
    [64, 64, 64, 16], // shrink immediately, clamped at the minimum
    [128, 128, 16, 64],
    [64, 64, 3, 128], // growth capped at 2x, even if the estimate is larger
    [300, 300, 1, 500],
    [64, 64, 0, 128],
    [64, 64, -1, 128],
    [64, 17, 3, 45], // floor, and use attempted rows rather than capacity
    [128, 0, 100, 128], // a metadata-only transaction is not a sample
    [128, -1, 100, 128],
    [16, 16, 1000, 16],
  ];
  for (const [current, attempted, elapsed, expected] of cases) {
    test(`nextCommitRowLimit(${current}, ${attempted}, ${elapsed}) = ${expected}`, () => {
      expect(nextCommitRowLimit(current!, attempted!, elapsed!)).toBe(expected!);
    });
  }
});

for (const mode of ["MEMORY", "WAL"] as const) {
  describe(`${mode} adaptive ingest sub-transactions`, () => {
    test("slow commits shrink; cheap and all-duplicate prefixes grow at most twofold", () => {
      const parts = [...lines(64), ...lines(16).map(part => part.replace('"status":200', '"status":404')), ...lines(420, 64)];
      const path = ledger(parts);
      const db = database(mode);
      const writes: { offset: string; completion: Record<string, string> }[] = [];
      const ingest = steps(db, path, 0, { now: clock([64, 1, 1, 1, 1, 1]), beforeWrite: () => {
        writes.push({ offset: meta(db).indexed_offset!, completion: completionMeta(db) });
      } });
      const ends = rowEnds(parts);
      let attempted = 0;
      for (const take of [64, 16, 32, 64, 128]) {
        attempted += take;
        expect(prefix(ingest, db).done).toBe(false);
        expect(Number(meta(db).indexed_offset)).toBe(ends[attempted - 1]!);
        assertRows(db, parts.slice(0, attempted));
        expect(completionMeta(db)).toEqual(SENTINELS);
      }
      // The last drain transaction and metadata-only final commit share one
      // step: no yield follows the last commit of a drain.
      expect(ingest.next()).toEqual({ done: true, value: 484 });
      expect(writes.map(write => write.offset)).toEqual(
        [0, 64, 80, 112, 176, 304, 500].map(count => count ? String(ends[count - 1]) : "0"),
      );
      expect(writes.every(write => JSON.stringify(write.completion) === JSON.stringify(SENTINELS))).toBe(true);
      assertRows(db, parts);
      assertComplete(db, path);
    });

    for (const stopAt of [64, 80]) {
      test(`return after ${stopAt} attempted rows checkpoints exactly; resume preserves the first duplicate payload`, () => {
        const parts = [...lines(64), ...lines(16, 64), line(3, { status: 404 }), ...lines(919, 80)];
        const path = ledger(parts);
        const db = database(mode);
        const ingest = steps(db, path, 0, { now: clock([64, 1]) });
        expect(prefix(ingest, db).done).toBe(false);
        if (stopAt === 80) expect(prefix(ingest, db).done).toBe(false);
        const offset = rowEnds(parts)[stopAt - 1]!;
        expect(meta(db).indexed_offset).toBe(String(offset));
        assertRows(db, parts.slice(0, stopAt));
        const before = meta(db);
        expect(ingest.return(0).done).toBe(true);
        expect(meta(db)).toEqual(before);
        expect(finish(steps(db, path, offset))).toBe(999 - stopAt);
        assertRows(db, parts);
        assertComplete(db, path);
      });
    }

    test("mixed byte lines around prefix boundaries resume exactly and a completed suffix is indexed once", () => {
      const skipped = ["", "{not json", JSON.stringify({ requestId: "missing-fields" }),
        line(9999, { pad: "x".repeat(REQUEST_HISTORY_MAX_RECORD_BYTES + 1) })];
      const accepted = [...lines(63), line(63, { conversationId: "대화-✓🙂" }),
        line(64, { conversationId: "終端" }), ...lines(455, 65)];
      const parts = [...accepted.slice(0, 63), ...skipped, `${accepted[63]}\r`, ...skipped.slice(0, 2),
        accepted[64]!, ...accepted.slice(65), ...skipped.slice(0, 3)];
      const suffix = line(7777, { conversationId: "미완성-✓" });
      const path = ledger(parts, suffix);
      const full = database(mode, "full.sqlite");
      const resumed = database(mode, "resumed.sqlite");
      expect(finish(steps(full, path))).toBe(520);
      const interrupted = steps(resumed, path, 0, { now: clock([64]) });
      expect(prefix(interrupted, resumed).done).toBe(false);
      const boundary = rowEnds(parts)[63 + skipped.length]!;
      expect(meta(resumed).indexed_offset).toBe(String(boundary));
      assertRows(resumed, accepted.slice(0, 64));
      interrupted.return(0);
      expect(finish(steps(resumed, path, boundary))).toBe(456);
      expect(resumed.query("SELECT * FROM requests ORDER BY request_id").all())
        .toEqual(full.query("SELECT * FROM requests ORDER BY request_id").all());
      expect(meta(resumed)).toEqual(meta(full));
      assertRows(resumed, accepted);
      const lastLf = rowEnds(parts).at(-1)!;
      assertComplete(resumed, path, lastLf);
      expect(statSync(path).size).toBe(lastLf + Buffer.byteLength(suffix));
      appendFileSync(path, "\n");
      expect(finish(steps(resumed, path, lastLf))).toBe(1);
      assertRows(resumed, [...accepted, suffix]);
      assertComplete(resumed, path);
      expect(finish(steps(resumed, path, Number(meta(resumed).indexed_offset)))).toBe(0);
      assertRows(resumed, [...accepted, suffix]);
    });

    test("busy attempts move no durable state or estimate; release commits the same 64 then 128 row prefixes", () => {
      const parts = lines(500);
      const path = ledger(parts);
      const db = database(mode);
      const blocker = new Database(join(dir, "index.sqlite"));
      handles.push(blocker);
      blocker.exec("PRAGMA busy_timeout = 0");
      blocker.exec("BEGIN IMMEDIATE");
      const before = meta(db);
      let attempts = 0;
      // Failed attempts consume only a start read. Give them huge time gaps;
      // the successful pair alone must size the next prefix.
      const times = [0, 1000, 2000, 2001];
      let calls = 0;
      const ingest = steps(db, path, 0, {
        beforeWrite: () => { attempts++; },
        now: () => times[calls++] ?? 2001 + (calls - times.length),
      });
      while (attempts < 2) {
        expect(ingest.next().done).toBe(false);
        expect(meta(db)).toEqual(before);
        expect(payloads(db)).toEqual([]);
      }
      expect(calls).toBe(2);
      blocker.exec("ROLLBACK");
      expect(prefix(ingest, db).done).toBe(false);
      expect(attempts).toBe(3);
      expect(meta(db).indexed_offset).toBe(String(rowEnds(parts)[63]));
      assertRows(db, parts.slice(0, 64));
      expect(prefix(ingest, db).done).toBe(false);
      expect(meta(db).indexed_offset).toBe(String(rowEnds(parts)[191]));
      assertRows(db, parts.slice(0, 192));
      expect(finish(ingest)).toBe(500);
      assertRows(db, parts);
      assertComplete(db, path);
    });

    test("40 busy retry yields are allowed and the 41st failed attempt throws without any write", () => {
      const path = ledger(lines(500));
      const db = database(mode);
      const blocker = new Database(join(dir, "index.sqlite"));
      handles.push(blocker);
      blocker.exec("BEGIN IMMEDIATE");
      const before = meta(db);
      let attempts = 0;
      let retryYields = 0;
      const ingest = steps(db, path, 0, { beforeWrite: () => { attempts++; } });
      try {
        while (attempts < 40) {
          const previous = attempts;
          expect(ingest.next().done).toBe(false);
          if (attempts > previous) retryYields++;
          expect(meta(db)).toEqual(before);
          expect(payloads(db)).toEqual([]);
        }
        expect(retryYields).toBe(40);
        let failure: unknown;
        try { ingest.next(); } catch (error) { failure = error; }
        expect(isSqliteBusy(failure)).toBe(true);
        expect(attempts).toBe(41);
        expect(meta(db)).toEqual(before);
        expect(payloads(db)).toEqual([]);
      } finally {
        blocker.exec("ROLLBACK");
      }
    });

    test("ledger replacement between committed prefixes throws stale before any further write", () => {
      const path = ledger(lines(500));
      const db = database(mode);
      const ingest = steps(db, path);
      expect(prefix(ingest, db).done).toBe(false);
      const before = meta(db);
      const rows = payloads(db);
      if (process.platform === "win32") {
        // Windows refuses to rename over a file the ingest still holds open;
        // shrinking it is the other replacement the ingest must detect.
        truncateSync(path, 1);
      } else {
        const replacement = ledger(lines(500, 5000), "", "replacement.jsonl");
        renameSync(replacement, path);
      }
      expect(() => ingest.next()).toThrow(RequestHistoryIndexStaleError);
      expect(meta(db)).toEqual(before);
      expect(payloads(db)).toEqual(rows);
    });

    test("a throwing beforeWrite stops the next prefix before writing", () => {
      const path = ledger(lines(500));
      const db = database(mode);
      let superseded = false;
      const failure = new Error("generation superseded");
      const ingest = steps(db, path, 0, { beforeWrite: () => { if (superseded) throw failure; } });
      expect(prefix(ingest, db).done).toBe(false);
      const before = meta(db);
      const rows = payloads(db);
      superseded = true;
      expect(() => ingest.next()).toThrow(failure);
      expect(meta(db)).toEqual(before);
      expect(payloads(db)).toEqual(rows);
    });

    test("a failure after seven inserts rolls back the entire file-backed transaction and resumes exactly", () => {
      const parts = lines(100);
      const path = ledger(parts);
      const db = database(mode);
      // RAISE(ABORT) is not swallowed by INSERT OR IGNORE. The enclosing Bun
      // transaction must roll back the seven earlier inserts too.
      db.exec(`CREATE TRIGGER fail_eighth BEFORE INSERT ON requests
        WHEN NEW.request_id = 'r-7' BEGIN SELECT RAISE(ABORT, 'injected eighth insert failure'); END`);
      const before = meta(db);
      expect(() => finish(steps(db, path))).toThrow("injected eighth insert failure");
      expect(payloads(db)).toEqual([]);
      expect(meta(db)).toEqual(before);
      expect(db.inTransaction).toBe(false);
      db.exec("DROP TRIGGER fail_eighth");
      expect(finish(steps(db, path, Number(meta(db).indexed_offset)))).toBe(100);
      assertRows(db, parts);
      assertComplete(db, path);
    });

    test("a failing final metadata update rolls back rows, offset, count and completion metadata together", () => {
      const parts = lines(100);
      const path = ledger(parts);
      const db = database(mode);
      // built_at_ms is written last: by this trigger, the transaction has
      // already inserted rows and updated offset, count, size and mtime.
      db.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE ON schema_meta
        WHEN NEW.key = '${HISTORY_META_KEYS.builtAtMs}'
        BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END`);
      const ingest = steps(db, path);
      expect(prefix(ingest, db).done).toBe(false);
      assertRows(db, parts.slice(0, 64));
      const before = meta(db);
      const committed = payloads(db);
      expect(() => finish(ingest)).toThrow("injected completion failure");
      expect(meta(db)).toEqual(before);
      expect(payloads(db)).toEqual(committed);
      expect(db.inTransaction).toBe(false);
      db.exec("DROP TRIGGER fail_completion");
      expect(finish(steps(db, path, Number(before.indexed_offset)))).toBe(36);
      assertRows(db, parts);
      assertComplete(db, path);
    });

    test("completion metadata changes only in the last successful transaction, including skipped trailing lines", () => {
      const accepted = lines(101);
      const parts = [...accepted, "", "{bad", "   "];
      const path = ledger(parts);
      const db = database(mode);
      const ingest = steps(db, path, 0, { now: clock([64, 1, 1]) });
      for (const attempted of [64, 80]) {
        expect(prefix(ingest, db).done).toBe(false);
        expect(meta(db).indexed_offset).toBe(String(rowEnds(parts)[attempted - 1]));
        assertRows(db, accepted.slice(0, attempted));
        expect(completionMeta(db)).toEqual(SENTINELS);
      }
      expect(finish(ingest)).toBe(101);
      assertRows(db, accepted);
      assertComplete(db, path);
    });

    for (const [name, parts] of [["empty", []], ["skipped-only", ["", "{bad", "{}", "   "]]] as const) {
      test(`${name} input completes with zero rows and exact metadata`, () => {
        const path = ledger([...parts]);
        const db = database(mode);
        expect(finish(steps(db, path))).toBe(0);
        assertRows(db, []);
        assertComplete(db, path);
      });
    }

    test("EOF at 500 rows leaves a metadata-only final commit after the staging drain", () => {
      const parts = lines(500);
      const path = ledger(parts);
      const db = database(mode);
      const beforeWrites: { offset: string; completion: Record<string, string> }[] = [];
      const ingest = steps(db, path, 0, { beforeWrite: () => {
        beforeWrites.push({ offset: meta(db).indexed_offset!, completion: completionMeta(db) });
      } });
      const end = statSync(path).size;
      let result = prefix(ingest, db);
      while (!result.done) {
        expect(Number(meta(db).indexed_offset)).toBeLessThan(end);
        expect(completionMeta(db)).toEqual(SENTINELS);
        result = prefix(ingest, db);
      }
      expect(result.value).toBe(500);
      // beforeWrite observes the state after the staging drain, immediately
      // before the metadata-only final transaction in that same step.
      expect(beforeWrites.at(-1)).toEqual({ offset: String(end), completion: SENTINELS });
      expect(beforeWrites.filter(write => write.offset === String(end))).toHaveLength(1);
      expect(beforeWrites.every(write => JSON.stringify(write.completion) === JSON.stringify(SENTINELS))).toBe(true);
      assertRows(db, parts);
      assertComplete(db, path);
    });
  });
}

test("WAL overlapping tails retain exact unique rows, counts, offsets and newer source metadata", () => {
  const initial = lines(50);
  const path = ledger(initial);
  const older = database("WAL");
  expect(finish(steps(older, path))).toBe(50);
  const from = Number(meta(older).indexed_offset);
  const tail = [...lines(1000, 50), line(3, { status: 404 })];
  appendFileSync(path, `${tail.join("\n")}\n`);
  const slow = steps(older, path, from, { now: clock([64]) });
  expect(prefix(slow, older).done).toBe(false);
  assertRows(older, [...initial, ...tail.slice(0, 64)]);
  const extra = lines(100, 2000);
  appendFileSync(path, `${extra.join("\n")}\n`);
  const newer = new Database(join(dir, "index.sqlite"));
  handles.push(newer);
  newer.exec("PRAGMA busy_timeout = 0");
  expect(finish(steps(newer, path, from))).toBe(1036);
  assertRows(newer, [...initial, ...tail, ...extra]);
  assertComplete(newer, path);
  const newerMeta = meta(newer);
  expect(finish(slow)).toBe(64);
  expect(meta(older)).toEqual(newerMeta);
  assertRows(older, [...initial, ...tail, ...extra]);
});

/** Capture only the driver's zero-delay timers and drive them without sleeps. */
function driverTimers(): { tick: () => void; restore: () => void } {
  const scheduled = new Map<ReturnType<typeof setTimeout>, () => void>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let sequence = 0;
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void,
    delay?: number, ...args: unknown[]) => {
    if (delay !== 0) return originalSet(callback, delay, ...args);
    const token = ++sequence as unknown as ReturnType<typeof setTimeout>;
    scheduled.set(token, () => callback(...args));
    return token;
  }) as typeof setTimeout);
  const clears = spyOn(globalThis, "clearTimeout").mockImplementation((token) => {
    if (!scheduled.delete(token as ReturnType<typeof setTimeout>)) originalClear(token);
  });
  return {
    tick: () => {
      const next = scheduled.entries().next().value;
      if (!next) throw new Error("no scheduled indexer step");
      scheduled.delete(next[0]);
      next[1]();
    },
    restore: () => { timers.mockRestore(); clears.mockRestore(); },
  };
}

test("cancelling a public rebuild after a committed private prefix publishes nothing and removes all build files", async () => {
  mkdirSync(getConfigDir(), { recursive: true });
  const parts = lines(2000);
  writeFileSync(usageLogPath(), `${parts.join("\n")}\n`);
  setRequestHistoryBudgetsForTests({ sliceMs: 0, syncBudgetMs: 0 });
  const timers = driverTimers();
  const pending = rebuildRequestHistoryIndex();
  // Attach rejection handling before close cancels the promise.
  const outcome = pending.then(value => value, (error: unknown) => error);
  const indexDir = historyIndexDir(getConfigDir());
  let committed = false;
  try {
    for (let index = 0; index < 100 && !committed; index++) {
      const names = readdirSync(indexDir);
      expect(names.some(name => name.startsWith("g"))).toBe(false);
      const buildName = names.find(name => /^b.*\.sqlite$/.test(name));
      expect(buildName).toBeDefined();
      const reader = new Database(join(indexDir, buildName!), { readonly: true });
      try {
        const count = Number(meta(reader).indexed_rows);
        if (count > 0) {
          expect(count).toBeLessThan(parts.length);
          assertRows(reader, parts.slice(0, count));
          expect(meta(reader).indexed_offset).toBe(String(rowEnds(parts)[count - 1]));
          committed = true;
        }
      } finally { reader.close(); }
      if (!committed) timers.tick();
    }
    expect(committed).toBe(true);
    closeRequestHistoryIndex();
    expect(await outcome).toBeInstanceOf(RequestHistoryIndexClosedError);
    expect(readdirSync(indexDir)).toEqual([]);
  } finally {
    closeRequestHistoryIndex();
    timers.restore();
  }
});

test("the actual private build uses MEMORY and synchronous OFF; the published generation uses WAL", async () => {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(usageLogPath(), `${lines(101).join("\n")}\n`);
  const original = Database.prototype.exec;
  const modes: unknown[] = [];
  const synchronous: unknown[] = [];
  const exec = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql: string) {
    const result = original.call(this, sql);
    if (sql === "PRAGMA journal_mode = MEMORY") modes.push(this.query("PRAGMA journal_mode").get());
    if (sql === "PRAGMA synchronous = OFF") synchronous.push(this.query("PRAGMA synchronous").get());
    return result;
  });
  try {
    const published = await openRequestHistoryIndex();
    expect(modes).toEqual([{ journal_mode: "memory" }]);
    expect(synchronous).toEqual([{ synchronous: 0 }]);
    expect(published.indexedRows).toBe(101);
    const reader = new Database(published.dbPath, { readonly: true });
    try { expect(reader.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" }); }
    finally { reader.close(); }
    expect(readdirSync(historyIndexDir(getConfigDir())).some(name => name.startsWith("b"))).toBe(false);
    expect(existsSync(published.dbPath)).toBe(true);
  } finally { exec.mockRestore(); }
});
