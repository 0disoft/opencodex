import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getConfigDir } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { newGenerationNames } from "../../src/routing/history/generations";
import {
  closeRequestHistoryIndex,
  drainRequestHistoryIoForTests,
  openRequestHistoryIndex,
  openRequestHistoryIndexSync,
  rebuildRequestHistoryIndex,
  REQUEST_HISTORY_WORKER_MIN_BYTES,
  RequestHistoryIndexBusyError,
  RequestHistoryIndexClosedError,
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
    expect(phases).toContain("worker-build");
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
    expect(phases).toContain("worker-build");
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
