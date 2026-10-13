/** Messages between the indexer and its index worker (#6990). Types only. */

import type { UsageLogRevision } from "../../usage/log";

export type RebuildWorkerRequest =
  | { type: "build"; buildPath: string; reason: string; revision: UsageLogRevision }
  | { type: "publish"; buildPath: string; generationPath: string }
  | { type: "release" }
  | { type: "checkpoint"; path: string }
  | { type: "reclaim"; paths: string[]; maxWalBytes: number };

export type RebuildWorkerReply =
  | { type: "built"; rows: number }
  | { type: "held" }
  | { type: "released" }
  | { type: "checkpointed" }
  | { type: "reclaimed"; removed: number }
  | { type: "error"; name: string; message: string; code: string | null };
