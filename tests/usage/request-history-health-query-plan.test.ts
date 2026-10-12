import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import {
  clearHealthHistoryCacheForTests,
  healthCandidateSql,
  healthEvidenceForCandidate,
  HEALTH_ATTEMPT_SQL,
  HEALTH_MAX_SAMPLES,
  HEALTH_WINDOW_MS,
} from "../../src/routing/health";
import { newGenerationNames } from "../../src/routing/history/generations";
import { ingestSteps, metaNumber, metaValue, setMeta } from "../../src/routing/history/ingest";
import {
  closeRequestHistoryIndex,
  openRequestHistoryIndex,
  rebuildRequestHistoryIndex,
  requestHistoryDb,
} from "../../src/routing/history/indexer";
import { HISTORY_DDL, HISTORY_META_KEYS, historyIndexDir, historyIndexPath } from "../../src/routing/history/schema";
import { currentUsageLogRevision, resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const now = 1_800_000_000_000;
const provider = "provider%_";
const model = "model%_";
const healthIndexes = ["idx_requests_attempts_ts", "idx_requests_provider_model_ts"];
let testDir = "";
let previousHome: string | undefined;

function row(requestId: string, overrides: Record<string, unknown> = {}) {
  return { requestId, timestamp: now - 2000, provider, model, status: 200,
    durationMs: 400, usageStatus: "reported", ...overrides };
}

function attempt(targetProvider: string, targetModel: string, status: number, durationMs: number) {
  return { ordinal: 1, provider: targetProvider, model: targetModel, adapter: "openai-chat",
    status, durationMs, sendCount: 1, recoveryKinds: [], usageStatus: "reported" };
}

function fixture() {
  return [
    row("same-target", { apiKeyId: "account-a", attempts: [
      attempt(provider, model, 503, 200), attempt(provider, model, 200, 400),
    ] }),
    row("account-b", { apiKeyId: "account-b", timestamp: now - 3000, durationMs: 800 }),
    row("cross-target", { provider: "other", model: "fallback", apiKeyId: "account-a",
      timestamp: now - 1000, attempts: [
        attempt(provider, model, 503, 600), attempt("other", "fallback", 200, 900),
      ] }),
    // Unescaped LIKE wildcards would also admit this row to the attempt query.
    row("wildcard-decoy", { provider: "other", model: "fallback", attempts: [
      attempt("providerXY", "modelXY", 503, 100), attempt("other", "fallback", 200, 100),
    ] }),
  ];
}

function writeLedger(rows: ReturnType<typeof row>[]): Buffer {
  mkdirSync(getConfigDir(), { recursive: true });
  const bytes = Buffer.from(`${rows.map(value => JSON.stringify(value)).join("\n")}\n`);
  writeFileSync(usageLogPath(), bytes);
  return bytes;
}

function indexes(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as
    Array<{ name: string }>).map(value => value.name).filter(name => healthIndexes.includes(name));
}

function rows(db: Database): unknown[] {
  return db.query("SELECT * FROM requests ORDER BY request_id").all();
}

function attemptBindings(): Array<string | number> {
  const escapeLike = (value: string) => value.replace(/[\\%_]/g, match => `\\${match}`);
  return [now - HEALTH_WINDOW_MS, `%\"provider\":\"${escapeLike(provider)}\"%`,
    `%\"model\":\"${escapeLike(model)}\"%`, provider, model, HEALTH_MAX_SAMPLES];
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-history-health-plan-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  closeRequestHistoryIndex();
  clearHealthHistoryCacheForTests();
});

afterEach(async () => {
  closeRequestHistoryIndex();
  clearHealthHistoryCacheForTests();
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(testDir);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(testDir);
});

describe("routing-health production SQL on schema v3", () => {
  test("the default planner uses both health indexes without sorting candidate rows", async () => {
    writeLedger([...fixture(), ...Array.from({ length: 1000 }, (_, index) =>
      row(`single-${index}`, { provider: "noise", model: "noise" }))]);
    expect((await openRequestHistoryIndex()).schemaVersion).toBe(3);
    const db = requestHistoryDb();
    expect(indexes(db)).toEqual(healthIndexes);
    for (const withAccount of [false, true]) {
      const bindings: Array<string | number> = [provider, model, now - HEALTH_WINDOW_MS];
      if (withAccount) bindings.push("account-a");
      bindings.push(HEALTH_MAX_SAMPLES);
      const plan = db.query(`EXPLAIN QUERY PLAN ${healthCandidateSql(withAccount)}`).all(...bindings) as
        Array<{ detail: string }>;
      expect(plan.some(value => value.detail.includes("idx_requests_provider_model_ts"))).toBe(true);
      expect(plan.some(value => value.detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(false);
    }
    const plan = db.query(`EXPLAIN QUERY PLAN ${HEALTH_ATTEMPT_SQL}`).all(...attemptBindings()) as
      Array<{ detail: string }>;
    expect(plan.some(value => value.detail.includes("idx_requests_attempts_ts"))).toBe(true);
    const matches = db.query(HEALTH_ATTEMPT_SQL).all(...attemptBindings()) as Array<{ rowJson: string }>;
    expect(matches.map(value => JSON.parse(value.rowJson).requestId)).toEqual(["cross-target"]);
  });

  test("cross-target attempts contribute once and candidate accounts isolate top-level samples", async () => {
    writeLedger(fixture());
    await openRequestHistoryIndex();
    const all = healthEvidenceForCandidate({ provider, model, now });
    expect(all.sampleCount).toBe(4);
    expect(all.successRate).toBeCloseTo(0.5, 3);
    expect(all.failures).toBe(2);
    expect(all.recentLatencyMs).toBe(500);
    const accountA = healthEvidenceForCandidate({ provider, model, accountRef: "account-a", now });
    expect(accountA.sampleCount).toBe(3);
    expect(accountA.failures).toBe(2);
    expect(accountA.successRate).toBeCloseTo(1 / 3, 3);
    expect(accountA.recentLatencyMs).toBe(400);
    const accountB = healthEvidenceForCandidate({ provider, model, accountRef: "account-b", now });
    // Production account filtering applies to top-level rows; cross-target
    // attempts remain shared evidence, preserving the existing bindings.
    expect(accountB.sampleCount).toBe(2);
    expect(accountB.failures).toBe(1);
    expect(accountB.successRate).toBeCloseTo(0.5, 3);
    expect(accountB.recentLatencyMs).toBe(700);
  });
});

/** Build the v2 schema directly, without ever opening a v3 index first. */
function buildV2(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec(HISTORY_DDL.split("\n").filter(line =>
      !healthIndexes.some(name => line.includes(name))).join("\n"));
    db.exec("PRAGMA journal_mode = WAL");
    const source = currentUsageLogRevision()!;
    setMeta(db, HISTORY_META_KEYS.schemaVersion, 2);
    setMeta(db, HISTORY_META_KEYS.sourcePath, source.path);
    setMeta(db, HISTORY_META_KEYS.sourceDev, source.dev);
    setMeta(db, HISTORY_META_KEYS.sourceIno, source.ino);
    setMeta(db, HISTORY_META_KEYS.sourceBirthtimeMs, source.birthtimeMs);
    setMeta(db, HISTORY_META_KEYS.lastError, "");
    const ingest = ingestSteps(db, source.path, 0, { expected: source });
    while (!ingest.next().done) { /* drain the canonical ledger */ }
    expect(metaValue(db, HISTORY_META_KEYS.schemaVersion)).toBe("2");
    expect(indexes(db)).toEqual([]);
  } finally {
    db.close();
  }
}

describe("schema v2 upgrade with initialized readers", () => {
  for (const legacy of [false, true]) {
    test(legacy ? "released legacy single-file v2 upgrades without disturbing its reader or ledger"
      : "generation v2 rebuilds privately as v3 while its reader stays usable", async () => {
      const canonical = fixture();
      const bytes = writeLedger(canonical);
      const oldPath = legacy ? historyIndexPath(getConfigDir())
        : newGenerationNames(historyIndexDir(getConfigDir()), 1).generationPath;
      buildV2(oldPath);
      const reader = new Database(oldPath, { readonly: true });
      try {
        reader.exec("BEGIN");
        const before = rows(reader); // Initializes the connection and pins its snapshot.
        expect(before).toHaveLength(canonical.length);
        expect(metaNumber(reader, HISTORY_META_KEYS.indexedOffset)).toBe(bytes.length);
        const upgraded = await openRequestHistoryIndex();
        expect(upgraded.dbPath).not.toBe(oldPath);
        expect(dirname(upgraded.dbPath)).toBe(historyIndexDir(getConfigDir()));
        expect(upgraded.schemaVersion).toBe(3);
        if (!legacy) expect(upgraded.lastError).toBe("schema version 2 -> 3; index rebuilt");
        expect(upgraded.indexedRows).toBe(canonical.length);
        expect(upgraded.indexedOffset).toBe(bytes.length);
        expect(metaValue(requestHistoryDb(), HISTORY_META_KEYS.schemaVersion)).toBe("3");
        expect(indexes(requestHistoryDb())).toEqual(healthIndexes);
        expect(rows(requestHistoryDb())).toEqual(before);
        expect(readFileSync(usageLogPath())).toEqual(bytes);
        // Awaiting a manual rebuild also drains reclamation, proving the old
        // file survives an actual reclaim attempt while the reader owns it.
        await rebuildRequestHistoryIndex();
        expect(existsSync(oldPath)).toBe(true);
        expect(rows(reader)).toEqual(before);
        expect(metaValue(reader, HISTORY_META_KEYS.schemaVersion)).toBe("2");
        reader.exec("COMMIT");
      } finally {
        reader.close();
      }
      await rebuildRequestHistoryIndex();
      expect(existsSync(oldPath)).toBe(false);
      expect(readFileSync(usageLogPath())).toEqual(bytes);
    });
  }
});
