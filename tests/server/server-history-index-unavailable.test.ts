import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeRequestHistoryIndex,
  setRequestHistoryRebuildWorkerForTests,
  setRequestHistoryStepObserverForTests,
} from "../../src/routing/history/indexer";
import { usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  currentServerFixtureConfig,
  managementHeaders,
  settleServerAuthFixture,
  startManagementServerFixture,
  type ManagementServerFixture,
} from "../helpers/server-auth-fixture";

// #6990: a request-history read that meets a closing index is transient. The
// management boundary answers 503 with Retry-After instead of a generic 500.

let previousHome: string | undefined;
let configDir = "";
let fixture: ManagementServerFixture | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  configDir = mkdtempSync(join(tmpdir(), "ocx-history-unavailable-"));
});

afterEach(async () => {
  setRequestHistoryStepObserverForTests(null);
  setRequestHistoryRebuildWorkerForTests(null);
  await fixture?.close();
  fixture = null;
  await settleServerAuthFixture(configDir);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(configDir);
});

test("a history read cut off by an index close answers 503 with Retry-After", async () => {
  fixture = await startManagementServerFixture(configDir, currentServerFixtureConfig({
    port: 0,
    defaultProvider: "a",
    providers: { a: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", apiKey: "ka", models: ["m1"] } },
  }));
  const lines = Array.from({ length: 5_000 }, (_, index) => JSON.stringify({
    requestId: `r-${index}`,
    timestamp: 1_790_000_000_000 - index,
    provider: "a", model: "m1", status: 200, durationMs: 10,
    usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, totalTokens: 2,
    surface: "codex",
  }));
  writeFileSync(usageLogPath(), `${lines.join("\n")}\n`);
  setRequestHistoryRebuildWorkerForTests("worker");
  let building!: () => void;
  const started = new Promise<void>(resolve => { building = resolve; });
  setRequestHistoryStepObserverForTests(sample => { if (sample.phase === "worker-build") building(); });

  const base = `http://127.0.0.1:${fixture.server.port}`;
  const response = fetch(`${base}/api/request-history?limit=1`, { headers: managementHeaders() });
  await started;
  closeRequestHistoryIndex();

  const answered = await response;
  expect(answered.status).toBe(503);
  expect(answered.headers.get("retry-after")).toBe("1");
  const body = await answered.json() as { error: { type: string; code: string; message: string } };
  expect(body.error.code).toBe("request_history_index_closed");
  expect(body.error.type).toBe("server_error");
});
