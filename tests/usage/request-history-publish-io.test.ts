import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getConfigDir } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import {
  closeRequestHistoryIndex,
  drainRequestHistoryIoForTests,
  openRequestHistoryIndex,
  openRequestHistoryIndexSync,
  queryRequestHistory,
  requestHistoryDb,
  requestHistoryIndexEpoch,
  RequestHistoryIndexBusyError,
  RequestHistoryIndexClosedError,
  setRequestHistoryBudgetsForTests,
  setRequestHistoryPublishIoForTests,
  setRequestHistoryStepObserverForTests,
  type RequestHistoryPublishIo,
  type RequestHistoryStepSample,
} from "../../src/routing/history/indexer";
import { RequestHistoryIndexStaleError } from "../../src/routing/history/ingest";
import { historyIndexDir } from "../../src/routing/history/schema";
import { resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

function rowsFor(count: number, start = 0): string[] {
  return Array.from({ length: count }, (_, offset) => JSON.stringify({
    requestId: `r-${start + offset}`,
    timestamp: 1_790_000_000_000 - offset,
    provider: "a", model: "m1", status: 200, durationMs: 10,
    usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 2 }, totalTokens: 12,
    surface: "codex",
  }));
}

function writeLedger(lines: string[]): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(usageLogPath(), `${lines.join("\n")}\n`);
}

function indexFiles(prefix: "b" | "g"): string[] {
  const dir = historyIndexDir(getConfigDir());
  return existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(prefix) && (prefix === "b" || name.endsWith(".sqlite"))).sort() : [];
}

const turn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

async function turns(count = 5): Promise<void> {
  for (let index = 0; index < count; index++) await turn();
}

async function until(predicate: () => boolean): Promise<void> {
  // Bound by event-loop turns, never elapsed time. A broken dispatch cannot hang teardown.
  for (let index = 0; index < 200 && !predicate(); index++) await turn();
  expect(predicate()).toBe(true);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function observe<T>(promise: Promise<T>) {
  const state = { settled: false, rejections: 0, error: undefined as unknown };
  void promise.then(() => { state.settled = true; }, error => {
    state.settled = true;
    state.rejections += 1;
    state.error = error;
  });
  return { promise, state };
}

function heldIo(phase: "rename" | "warm") {
  const gate = deferred();
  const state = { calls: 0, from: "", path: "" };
  const hooks: Partial<RequestHistoryPublishIo> = phase === "rename" ? {
    rename: (from, to) => {
      state.calls += 1;
      state.from = from;
      state.path = to;
      return gate.promise.then(() => rename(from, to));
    },
  } : {
    warm: path => {
      state.calls += 1;
      state.path = path;
      return gate.promise;
    },
  };
  return { state, hooks, release: gate.resolve };
}

async function expectRows(count: number, start = 0): Promise<void> {
  const page = await queryRequestHistory({}, undefined, 100);
  expect(page.meta.indexedRows).toBe(count);
  expect(page.rows.map(row => row.requestId).sort()).toEqual(
    Array.from({ length: count }, (_, index) => `r-${start + index}`).sort(),
  );
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-history-publish-io-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  closeRequestHistoryIndex();
  setRequestHistoryPublishIoForTests(null);
  setRequestHistoryBudgetsForTests(null);
  setRequestHistoryStepObserverForTests(null);
});

afterEach(async () => {
  closeRequestHistoryIndex();
  await drainRequestHistoryIoForTests();
  setRequestHistoryPublishIoForTests(null);
  setRequestHistoryBudgetsForTests(null);
  setRequestHistoryStepObserverForTests(null);
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(testDir);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(testDir);
});

describe("request-history publication I/O", () => {
  test("held async rename permits five timer turns, keeps readers pending and dispatches once", async () => {
    writeLedger(rowsFor(12));
    const hold = heldIo("rename");
    const samples: RequestHistoryStepSample[] = [];
    setRequestHistoryPublishIoForTests(hold.hooks);
    setRequestHistoryStepObserverForTests(sample => { samples.push(sample); });
    const read = observe(openRequestHistoryIndex());
    try {
      await until(() => hold.state.calls === 1);
      const sampleCount = samples.length;
      await turns();
      expect(read.state.settled).toBe(false);
      expect(samples.length).toBe(sampleCount); // No slice advances a waiting generator.
      expect(samples.some(sample => sample.phase === "publish-rename")).toBe(true);
      expect(indexFiles("g")).toEqual([]);
      expect(indexFiles("b")).toEqual([basename(hold.state.from)]);
      expect(() => requestHistoryDb()).toThrow();
      expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
      expect(hold.state.calls).toBe(1);
      hold.release(); // The hook performs the real fs.promises.rename before settling.
      const meta = await read.promise;
      expect(meta.dbPath).toBe(hold.state.path);
      expect(meta.indexedRows).toBe(12);
      expect(indexFiles("g")).toEqual([basename(meta.dbPath)]);
      expect(indexFiles("b")).toEqual([]);
      expect(hold.state.calls).toBe(1);
      await expectRows(12);
    } finally {
      hold.release();
    }
  });

  test("held warm follows the real rename and prevents adoption until it settles", async () => {
    writeLedger(rowsFor(9));
    const hold = heldIo("warm");
    setRequestHistoryPublishIoForTests(hold.hooks);
    const read = observe(openRequestHistoryIndex());
    try {
      await until(() => hold.state.calls === 1);
      const epoch = requestHistoryIndexEpoch();
      await turns();
      expect(existsSync(hold.state.path)).toBe(true);
      expect(indexFiles("b")).toEqual([]);
      expect(read.state.settled).toBe(false);
      expect(() => requestHistoryDb()).toThrow();
      expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
      expect(requestHistoryIndexEpoch()).toBe(epoch);
      hold.release();
      expect((await read.promise).dbPath).toBe(hold.state.path);
      await expectRows(9);
    } finally {
      hold.release();
    }
  });

  test("an already fulfilled rename promise is consumed once", async () => {
    writeLedger(rowsFor(7));
    let calls = 0;
    setRequestHistoryPublishIoForTests({ rename: (from, to) => {
      calls += 1;
      renameSync(from, to);
      return Promise.resolve();
    } });
    expect((await openRequestHistoryIndex()).indexedRows).toBe(7);
    expect(calls).toBe(1);
    expect(indexFiles("b")).toEqual([]);
    await expectRows(7);
  });

  for (const kind of ["error", "undefined", "throw-undefined"] as const) {
    test(`an immediate rename ${kind} failure rejects once, cleans up and allows recovery`, async () => {
      writeLedger(rowsFor(8));
      const failure = Object.assign(new Error("rename denied"), { code: "EACCES" });
      let calls = 0;
      setRequestHistoryPublishIoForTests({ rename: () => {
        calls += 1;
        if (kind === "throw-undefined") throw undefined;
        return Promise.reject(kind === "error" ? failure : undefined);
      } });
      const read = observe(openRequestHistoryIndex());
      await until(() => read.state.settled);
      expect(read.state.rejections).toBe(1);
      if (kind === "error") expect(read.state.error).toBe(failure);
      else expect(read.state.error).toBeInstanceOf(Error);
      await drainRequestHistoryIoForTests();
      await turns();
      expect(read.state.rejections).toBe(1);
      expect(calls).toBe(1);
      expect(indexFiles("b")).toEqual([]);
      expect(indexFiles("g")).toEqual([]);
      setRequestHistoryPublishIoForTests(null);
      expect((await openRequestHistoryIndex()).indexedRows).toBe(8);
      await expectRows(8);
    });
  }

  test("warm ENOENT restarts a stale publication and rebuilds the missing generation", async () => {
    writeLedger(rowsFor(11));
    let renames = 0;
    let warms = 0;
    let missing = "";
    setRequestHistoryPublishIoForTests({
      rename: (from, to) => { renames += 1; return rename(from, to); },
      warm: path => {
        warms += 1;
        if (warms !== 1) return Promise.resolve();
        missing = path;
        unlinkSync(path);
        return Promise.reject(Object.assign(new Error("generation removed"), { code: "ENOENT" }));
      },
    });
    const meta = await openRequestHistoryIndex();
    expect(meta.dbPath).not.toBe(missing);
    expect(renames).toBe(2);
    expect(warms).toBe(2);
    expect(existsSync(missing)).toBe(false);
    await expectRows(11);
  });

  test("a non-ENOENT warm failure still publishes the readable generation", async () => {
    writeLedger(rowsFor(6));
    let warms = 0;
    let warmed = "";
    setRequestHistoryPublishIoForTests({ warm: path => {
      warms += 1;
      warmed = path;
      return Promise.reject(Object.assign(new Error("warm denied"), { code: "EACCES" }));
    } });
    expect((await openRequestHistoryIndex()).dbPath).toBe(warmed);
    expect(warms).toBe(1);
    await expectRows(6);
  });

  test("repeated warm ENOENT failures exhaust the bounded stale restart, then recover", async () => {
    writeLedger(rowsFor(4));
    let warms = 0;
    setRequestHistoryPublishIoForTests({ warm: path => {
      warms += 1;
      unlinkSync(path);
      return Promise.reject(Object.assign(new Error("removed"), { code: "ENOENT" }));
    } });
    await expect(openRequestHistoryIndex()).rejects.toBeInstanceOf(RequestHistoryIndexStaleError);
    expect(warms).toBe(3);
    await drainRequestHistoryIoForTests();
    expect(indexFiles("b")).toEqual([]);
    expect(indexFiles("g")).toEqual([]);
    setRequestHistoryPublishIoForTests(null);
    await expectRows(4);
  });

  for (const phase of ["rename", "warm"] as const) {
    test(`close during held ${phase} rejects immediately and drains late I/O without an unhandled rejection`, async () => {
      writeLedger(rowsFor(10));
      const hold = heldIo(phase);
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => { unhandled.push(error); };
      process.on("unhandledRejection", onUnhandled);
      setRequestHistoryPublishIoForTests(hold.hooks);
      const read = observe(openRequestHistoryIndex());
      try {
        await until(() => hold.state.calls === 1);
        closeRequestHistoryIndex();
        await expect(read.promise).rejects.toBeInstanceOf(RequestHistoryIndexClosedError);
        expect(read.state.rejections).toBe(1); // Gate is still held: cancellation does not wait for I/O.
        const drain = observe(drainRequestHistoryIoForTests());
        await turns();
        expect(drain.state.settled).toBe(false);
        if (phase === "rename") expect(existsSync(hold.state.from)).toBe(true);
        hold.release();
        await drain.promise;
        expect(existsSync(hold.state.path)).toBe(true);
        expect(indexFiles("b")).toEqual([]);
        setRequestHistoryPublishIoForTests(null);
        expect((await openRequestHistoryIndex()).indexedRows).toBe(10);
        await expectRows(10);
        await turns();
        expect(unhandled).toEqual([]);
      } finally {
        hold.release();
        await drainRequestHistoryIoForTests();
        process.off("unhandledRejection", onUnhandled);
      }
    });
  }

  test("replacing the ledger inode during warm restarts and excludes obsolete rows", async () => {
    writeLedger(rowsFor(13));
    const hold = heldIo("warm");
    setRequestHistoryPublishIoForTests(hold.hooks);
    const read = observe(openRequestHistoryIndex());
    try {
      await until(() => hold.state.calls === 1);
      const previousInode = statSync(usageLogPath()).ino;
      const replacement = `${usageLogPath()}.next`;
      writeFileSync(replacement, `${rowsFor(5, 100).join("\n")}\n`);
      renameSync(replacement, usageLogPath());
      expect(statSync(usageLogPath()).ino).not.toBe(previousInode);
      hold.release();
      const meta = await read.promise;
      expect(hold.state.calls).toBe(2);
      expect(meta.indexedRows).toBe(5);
      await expectRows(5, 100);
    } finally {
      hold.release();
    }
  });

  test("a newer complete generation appearing during warm is adopted on stale restart", async () => {
    writeLedger(rowsFor(14));
    const hold = heldIo("warm");
    setRequestHistoryPublishIoForTests(hold.hooks);
    const read = observe(openRequestHistoryIndex());
    try {
      await until(() => hold.state.calls === 1);
      const name = basename(hold.state.path);
      const stamp = Number(/^g(\d{15})-/.exec(name)![1]) + 1000;
      const newer = join(historyIndexDir(getConfigDir()), `g${String(stamp).padStart(15, "0")}-${process.pid}-999.sqlite`);
      copyFileSync(hold.state.path, newer);
      const db = new Database(newer);
      try { db.query("UPDATE schema_meta SET value = ? WHERE key = 'last_error'").run("newer generation sentinel"); }
      finally { db.close(); }
      hold.release();
      const meta = await read.promise;
      expect(meta.dbPath).toBe(newer);
      expect(meta.lastError).toBe("newer generation sentinel");
      expect(hold.state.calls).toBe(1); // Restart adopts, rather than dispatching another publication.
      await expectRows(14);
    } finally {
      hold.release();
    }
  });

test("a newer generation published during the synchronous open closes the candidate and restarts", async () => {
    writeLedger(rowsFor(9));
    const opened: Array<{ path: string; closed: boolean }> = [];
    let newer = "";
    setRequestHistoryPublishIoForTests({
      openGeneration: (path, defaultOpen) => {
        const handle = defaultOpen(path);
        const record = { path, closed: false };
        opened.push(record);
        const close = handle.close.bind(handle);
        handle.close = (...args: Parameters<Database["close"]>) => { record.closed = true; return close(...args); };
        if (!newer) {
          // Another process publishes between this open and adoption.
          const stamp = Number(/^g(\d{15})-/.exec(basename(path))![1]) + 1000;
          newer = join(historyIndexDir(getConfigDir()), `g${String(stamp).padStart(15, "0")}-${process.pid}-998.sqlite`);
          copyFileSync(path, newer);
          const db = new Database(newer);
          try { db.query("UPDATE schema_meta SET value = ? WHERE key = 'last_error'").run("published during open"); }
          finally { db.close(); }
        }
        return handle;
      },
    });
    const meta = await openRequestHistoryIndex();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.path).not.toBe(newer);
    expect(opened[0]!.closed).toBe(true);
    expect(meta.dbPath).toBe(newer);
    expect(meta.lastError).toBe("published during open");
    await expectRows(9);
  });

  test("a small cold sync rebuild uses renameSync and settles inline with default budgets", async () => {
    writeLedger(rowsFor(3));
    let syncRenames = 0;
    let asyncRenames = 0;
    let warms = 0;
    setRequestHistoryPublishIoForTests({
      renameSync: (from, to) => { syncRenames += 1; renameSync(from, to); },
      rename: (from, to) => { asyncRenames += 1; return rename(from, to); },
      warm: () => { warms += 1; return Promise.resolve(); },
    });
    expect(openRequestHistoryIndexSync().indexedRows).toBe(3);
    expect(syncRenames).toBe(1);
    expect(asyncRenames).toBe(0);
    expect(warms).toBe(0);
    await expectRows(3);
  });

  test("the observer attributes each synchronous publication phase to a separate sample", () => {
    writeLedger(rowsFor(3));
    const samples: RequestHistoryStepSample[] = [];
    setRequestHistoryStepObserverForTests(sample => { samples.push(sample); });
    expect(openRequestHistoryIndexSync().indexedRows).toBe(3);
    const required = ["publish-meta", "publish-wal", "publish-close", "publish-rename", "publish-open"];
    const indices = required.map(phase => samples.findIndex(sample => sample.phase.split("->").includes(phase)));
    expect(samples.flatMap(sample => sample.phase.split("->"))).toEqual(expect.arrayContaining(required));
    expect(new Set(indices).size).toBe(required.length);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  test("budget expiry immediately after sync rename hands its outcome off without replaying I/O", async () => {
    writeLedger(rowsFor(5));
    let clock = 0;
    let syncRenames = 0;
    let asyncRenames = 0;
    const now = spyOn(performance, "now").mockImplementation(() => clock);
    setRequestHistoryPublishIoForTests({
      renameSync: (from, to) => { syncRenames += 1; renameSync(from, to); clock = 100; },
      rename: (from, to) => { asyncRenames += 1; return rename(from, to); },
    });
    try {
      expect(() => openRequestHistoryIndexSync()).toThrow(RequestHistoryIndexBusyError);
      expect(syncRenames).toBe(1);
      expect(asyncRenames).toBe(0);
      expect(indexFiles("g")).toHaveLength(1);
      expect(() => requestHistoryDb()).toThrow();
      expect((await openRequestHistoryIndex()).indexedRows).toBe(5);
      expect(syncRenames).toBe(1);
      expect(asyncRenames).toBe(0);
      await expectRows(5);
    } finally {
      now.mockRestore();
    }
  });

  for (const phase of ["rename", "warm"] as const) {
    test(`late ${phase} from a closed flight cannot adopt or mutate a newer lifetime`, async () => {
      writeLedger(rowsFor(15));
      const hold = heldIo(phase);
      setRequestHistoryPublishIoForTests(hold.hooks);
      const old = observe(openRequestHistoryIndex());
      try {
        await until(() => hold.state.calls === 1);
        closeRequestHistoryIndex();
        await expect(old.promise).rejects.toBeInstanceOf(RequestHistoryIndexClosedError);
        // A different inode forces the new lifetime to build even when old warm already renamed.
        const replacement = `${usageLogPath()}.next`;
        writeFileSync(replacement, `${rowsFor(4, 200).join("\n")}\n`);
        renameSync(replacement, usageLogPath());
        setRequestHistoryPublishIoForTests(null);
        const current = await openRequestHistoryIndex();
        const handle = requestHistoryDb();
        const epoch = requestHistoryIndexEpoch();
        expect(current.dbPath).not.toBe(hold.state.path);
        expect(current.indexedRows).toBe(4);
        hold.release();
        await drainRequestHistoryIoForTests();
        await turns(); // Include any incorrectly scheduled old-flight continuation.
        expect(requestHistoryDb()).toBe(handle);
        expect(requestHistoryIndexEpoch()).toBe(epoch);
        expect(await openRequestHistoryIndex()).toEqual(current);
        expect(old.state.rejections).toBe(1);
        await expectRows(4, 200);
      } finally {
        hold.release();
      }
    });
  }
});
