/**
 * Rebuild worker for the request-history index (#6990).
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
 */

import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import { createBuildDatabase, finishBuildMeta } from "./build-file";
import { ingestSteps } from "./ingest";
import type { RebuildWorkerReply, RebuildWorkerRequest } from "./rebuild-protocol";

declare const self: Worker;

let build: Database | null = null;
let held: Database | null = null;

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
      const generation = new Database(request.generationPath, { readwrite: true });
      held = generation;
      generation.exec("PRAGMA journal_mode = WAL");
      generation.query("SELECT value FROM schema_meta LIMIT 1").get();
      return { type: "held" };
    }
    case "release": {
      closeQuietly(held);
      held = null;
      return { type: "released" };
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
