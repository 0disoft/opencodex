/**
 * The private build file of a request-history generation (#6990).
 *
 * Shared by the inline rebuild (small ledgers, routing-time sync entry) and
 * the rebuild worker (large ledgers), so both write identical rows and meta.
 */

import { Database } from "bun:sqlite";
import type { UsageLogRevision } from "../../usage/log";
import { removeBuildFiles } from "./generations";
import { setMeta } from "./ingest";
import { HISTORY_DDL, HISTORY_META_KEYS, HISTORY_SCHEMA_VERSION } from "./schema";

export function recordSourceMeta(dbHandle: Database, revision: UsageLogRevision | null): void {
  setMeta(dbHandle, HISTORY_META_KEYS.sourcePath, revision?.path ?? "");
  setMeta(dbHandle, HISTORY_META_KEYS.sourceDev, revision?.dev ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceIno, revision?.ino ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceBirthtimeMs, revision?.birthtimeMs ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceSize, revision?.size ?? 0);
  setMeta(dbHandle, HISTORY_META_KEYS.sourceMtimeMs, revision?.mtimeMs ?? 0);
}

/**
 * Create the private build database with its schema and starting meta. A
 * private build needs no crash durability: an interrupted build is discarded.
 * MEMORY keeps in-process ROLLBACK without a rollback file; DELETE created and
 * removed one per commit, which dominated commit time on Windows
 * (devlog/_plan/261013_rt284_l1_owner_bundle/060_windows_rebuild_lag.md).
 */
export function createBuildDatabase(buildPath: string, reason: string, revision: UsageLogRevision | null): Database {
  const build = new Database(buildPath, { create: true, readwrite: true });
  try {
    build.exec("PRAGMA journal_mode = MEMORY");
    build.exec("PRAGMA synchronous = OFF");
    build.exec(HISTORY_DDL);
    build.transaction(() => {
      setMeta(build, HISTORY_META_KEYS.schemaVersion, HISTORY_SCHEMA_VERSION);
      setMeta(build, HISTORY_META_KEYS.indexedOffset, 0);
      setMeta(build, HISTORY_META_KEYS.indexedRows, 0);
      setMeta(build, HISTORY_META_KEYS.builtAtMs, Date.now());
      setMeta(build, HISTORY_META_KEYS.lastError, reason);
      recordSourceMeta(build, revision);
    })();
    return build;
  } catch (error) {
    try { build.close(); } catch { /* already unusable */ }
    // A build that failed to initialize is nobody's to publish.
    removeBuildFiles(buildPath);
    throw error;
  }
}

/** Final meta of a complete build. The specific reason survives publication (#6990 used to overwrite it). */
export function finishBuildMeta(build: Database, reason: string): void {
  build.transaction(() => {
    setMeta(build, HISTORY_META_KEYS.lastError, reason);
    setMeta(build, HISTORY_META_KEYS.builtAtMs, Date.now());
  })();
}
