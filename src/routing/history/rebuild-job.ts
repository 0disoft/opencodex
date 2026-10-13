/**
 * The indexer's side of one index worker (#6990): spawn it, send one request
 * at a time, and take it down again. Every exit settles: a worker that errors
 * or exits rejects the pending request. dispose() is bounded; afterExit()
 * runs cleanup only once the thread has really exited, so files the thread
 * may still hold are never removed under it.
 */

import { spawnWorker } from "../../lib/worker-embed";
import { storageWorkerOsJoinSettleMs } from "../../storage/worker-lifecycle";
import type { UsageLogRevision } from "../../usage/log";
import { RequestHistoryIndexStaleError } from "./ingest";
import type { RebuildWorkerReply, RebuildWorkerRequest } from "./rebuild-protocol";

const RELEASE_TIMEOUT_MS = 2_000;
const CLOSE_TIMEOUT_MS = 5_000;

interface PendingRequest {
  expect: RebuildWorkerReply["type"];
  resolve: (reply: RebuildWorkerReply) => void;
  reject: (error: unknown) => void;
}

function errorFromReply(reply: Extract<RebuildWorkerReply, { type: "error" }>): Error {
  if (reply.name === "RequestHistoryIndexStaleError") return new RequestHistoryIndexStaleError(reply.message);
  const error = new Error(reply.message) as Error & { code?: string };
  error.name = reply.name;
  if (reply.code !== null) error.code = reply.code;
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** True when `promise` settles within `ms`; the timer is cleared either way so it never keeps a process alive. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([promise.then(() => true, () => true), expired]).finally(() => clearTimeout(timer));
}

export class IndexWorkerJob {
  private readonly worker: Worker;
  private pending: PendingRequest | null = null;
  private exited = false;
  private exitedCleanly = false;
  private held = false;
  private disposal: Promise<void> | null = null;
  private readonly closed: Promise<void>;

  constructor() {
    this.worker = spawnWorker(new URL("./rebuild-worker.ts", import.meta.url).href, "request-history-rebuild-worker");
    let markClosed!: () => void;
    this.closed = new Promise(resolve => { markClosed = resolve; });
    this.worker.addEventListener("message", (event: MessageEvent<RebuildWorkerReply>) => this.settle(event.data));
    this.worker.addEventListener("error", (event: Event) => {
      const message = (event as ErrorEvent).message || "request-history rebuild worker failed";
      this.fail(new Error(message));
    });
    this.worker.addEventListener("close", () => {
      this.exited = true;
      this.fail(new Error("request-history rebuild worker exited"));
      markClosed();
    }, { once: true });
  }

  private settle(reply: RebuildWorkerReply): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (reply.type === "error") pending.reject(errorFromReply(reply));
    else if (reply.type !== pending.expect) pending.reject(new Error("request-history rebuild worker replied " + reply.type + ", expected " + pending.expect));
    else pending.resolve(reply);
  }

  private fail(error: unknown): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  private request(message: RebuildWorkerRequest, expect: RebuildWorkerReply["type"]): Promise<RebuildWorkerReply> {
    if (this.exited || this.disposal) return Promise.reject(new Error("request-history rebuild worker is not running"));
    if (this.pending) return Promise.reject(new Error("request-history rebuild worker is busy"));
    return new Promise((resolve, reject) => {
      this.pending = { expect, resolve, reject };
      this.worker.postMessage(message);
    });
  }

  /** Build the complete private file; resolves with the ingested row count. */
  async build(buildPath: string, reason: string, revision: UsageLogRevision): Promise<number> {
    const reply = await this.request({ type: "build", buildPath, reason, revision }, "built");
    return reply.type === "built" ? reply.rows : 0;
  }

  /** Rename the build to its generation name and hold that generation open until dispose(). */
  async publish(buildPath: string, generationPath: string): Promise<void> {
    this.held = true;
    await this.request({ type: "publish", buildPath, generationPath }, "held");
  }

  /** Hold an existing generation open until dispose(), so the serving thread's close of it is never the last. */
  async hold(path: string): Promise<void> {
    this.held = true;
    await this.request({ type: "hold", path }, "held");
  }

  /** Checkpoint a published generation's WAL off the serving thread; false when a reader left frames behind. */
  async checkpoint(path: string): Promise<boolean> {
    const reply = await this.request({ type: "checkpoint", path }, "checkpointed");
    return reply.type === "checkpointed" && reply.complete;
  }

  /** Reclaim superseded databases off the serving thread; resolves with how many were removed. */
  async reclaim(paths: string[], maxWalBytes: number): Promise<number> {
    const reply = await this.request({ type: "reclaim", paths, maxWalBytes }, "reclaimed");
    return reply.type === "reclaimed" ? reply.removed : 0;
  }

  /** Release the held generation and stop the thread; waits a bounded time for it to exit. */
  dispose(): Promise<void> {
    this.disposal ??= this.shutDown();
    return this.disposal;
  }

  /**
   * Dispose, then run `cleanup` once the thread has exited. A thread that
   * overran the bound (blocked in native I/O) gets its cleanup when it does
   * exit; the returned promise does not wait for that.
   */
  async afterExit(cleanup: () => void | Promise<void>): Promise<void> {
    await this.dispose();
    if (this.exitedCleanly) {
      await cleanup();
      return;
    }
    void this.closed.then(() => delay(storageWorkerOsJoinSettleMs())).then(cleanup).catch(() => undefined);
  }

  private async shutDown(): Promise<void> {
    if (this.held && !this.exited && !this.pending) {
      const released = new Promise<RebuildWorkerReply>((resolve, reject) => {
        this.pending = { expect: "released", resolve, reject };
        this.worker.postMessage({ type: "release" } satisfies RebuildWorkerRequest);
      });
      await settlesWithin(released, RELEASE_TIMEOUT_MS);
    }
    this.fail(new Error("request-history rebuild worker stopped"));
    try { this.worker.terminate(); } catch { /* already gone */ }
    const closedInTime = await settlesWithin(this.closed, CLOSE_TIMEOUT_MS);
    if (!closedInTime) return;
    // Bun does not expose the OS thread join; Windows needs this gap before
    // the build files a terminated thread held can be removed.
    const settleMs = storageWorkerOsJoinSettleMs();
    if (settleMs > 0) await delay(settleMs);
    this.exitedCleanly = true;
  }
}
