/** Messages between the indexer and its rebuild worker (#6990). Types only. */

import type { UsageLogRevision } from "../../usage/log";

export type RebuildWorkerRequest =
  | { type: "build"; buildPath: string; reason: string; revision: UsageLogRevision }
  | { type: "publish"; buildPath: string; generationPath: string }
  | { type: "release" };

export type RebuildWorkerReply =
  | { type: "built"; rows: number }
  | { type: "held" }
  | { type: "released" }
  | { type: "error"; name: string; message: string; code: string | null };
