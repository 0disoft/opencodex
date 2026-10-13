/**
 * Worker for the request-history index (#6990): full rebuilds, WAL
 * checkpoints and reclamation of superseded generations.
 *
 * Runs every synchronous SQLite and file step of a full rebuild on its own
 * thread: creating the private build, ingesting the ledger, switching it to
 * WAL, closing it and renaming it to its generation name. It then opens the
 * published generation itself and keeps it open until the indexer has opened
 * it, so the serving thread attaches to a file whose WAL side files already
 * exist and whose first open (and any on-access scan) happened here.
 *
 * Hosted Windows runners stalled the serving loop for 0.5-1.2 s inside those
 * steps while using almost no CPU; cooperative yielding cannot split a single
 * blocking open, close or commit.
 *
 * The serving connection never checkpoints on its own (`wal_autocheckpoint =
 * 0`): a checkpoint syncs the database file. A job on this worker runs it, and
 * reclaims old generations (open, journal switch, checkpoint, delete), so
 * neither lands on the serving thread either.
 */

import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import { createBuildDatabase, finishBuildMeta } from "./build-file";
import { reclaimDatabase } from "./generations";
import { ingestSteps } from "./ingest";
import type { RebuildWorkerReply, RebuildWorkerRequest } from "./rebuild-protocol";

declare const self: Worker;

let build: Database | null = null;
// Generations this worker keeps open so the serving thread's open or close is
// never the first or last connection: the superseded one (its close
// checkpoints here) and the newly published one.
let held: Database[] = [];

function closeQuietly(handle: Database | null): void {
  try { handle?.close(); } catch { /* already closed */ }
}

function failure(error: unknown): RebuildWorkerReply {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    type: "error",
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: typeof code === "string" ? code : null,
  };
}

function holdOpen(path: string): void {
  const generation = new Database(path, { readwrite: true });
  held.push(generation);
  // Any first statement attaches this connection to the WAL; it reads only
  // the header, so a generation with damaged tables can still be held.
  generation.query("PRAGMA schema_version").get();
}

/**
 * Leave one frame in the WAL that is not yet checkpointed. A writer restarts
 * the WAL (rewriting and syncing its header) only when every frame is already
 * backfilled, so with this frame in place the serving thread's next tail
 * appends instead. The write rewrites user_version unchanged.
 */
function primeWal(db: Database): void {
  db.exec("PRAGMA busy_timeout = 1000");
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  db.exec(`PRAGMA user_version = ${Number(version) | 0}`);
}

function handle(request: RebuildWorkerRequest): RebuildWorkerReply {
  switch (request.type) {
    case "build": {
      const { buildPath, reason, revision } = request;
      const fresh = createBuildDatabase(buildPath, reason, revision);
      build = fresh;
      // Nothing else shares this thread: full batches, no timing-sized sub-transactions.
      const steps = ingestSteps(fresh, revision.path, 0, {
        expected: revision,
        endOffset: Number(revision.size),
        now: () => 0,
      });
      let step = steps.next();
      while (!step.done) step = steps.next();
      finishBuildMeta(fresh, reason);
      fresh.exec("PRAGMA journal_mode = WAL");
      fresh.close();
      build = null;
      return { type: "built", rows: step.value };
    }
    case "publish": {
      renameSync(request.buildPath, request.generationPath);
      holdOpen(request.generationPath);
      // The published WAL is empty; its first write (and header sync) is this one.
      // Best effort: the rename already published a complete generation.
      try { primeWal(held[held.length - 1]!); } catch { /* another process holds the write lock */ }
      return { type: "held" };
    }
    case "hold": {
      holdOpen(request.path);
      return { type: "held" };
    }
    case "release": {
      for (const generation of held) closeQuietly(generation);
      held = [];
      return { type: "released" };
    }
    case "checkpoint": {
      const db = new Database(request.path, { readwrite: true });
      try {
        db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(request.busyTimeoutMs))}`);
        // TRUNCATE copies every frame back and empties the WAL; it waits up to
        // the busy timeout for readers, and reports busy when one held on.
        const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as
          | { busy: number; log: number; checkpointed: number }
          | undefined;
        // Whatever the outcome (emptied, or fully backfilled but a reader kept
        // it from resetting), the restart and its header sync happen here,
        // while the indexer holds its tails back, and never on the serving thread.
        primeWal(db);
        return { type: "checkpointed", complete: result !== undefined && result.busy === 0 };
      } finally {
        closeQuietly(db);
      }
    }
    case "reclaim": {
      let removed = 0;
      for (const path of request.paths) if (reclaimDatabase(path, request.maxWalBytes)) removed += 1;
      return { type: "reclaimed", removed };
    }
  }
}

self.onmessage = (event: MessageEvent<RebuildWorkerRequest>) => {
  try {
    self.postMessage(handle(event.data));
  } catch (error) {
    closeQuietly(build);
    build = null;
    self.postMessage(failure(error));
  }
};
