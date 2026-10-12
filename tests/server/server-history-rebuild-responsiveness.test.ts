import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRequestHistoryStepObserverForTests, type RequestHistoryStepSample } from "../../src/routing/history/indexer";
import { usageLogPath } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  currentServerFixtureConfig,
  managementHeaders,
  settleServerAuthFixture,
  startManagementServerFixture,
  type ManagementServerFixture,
} from "../helpers/server-auth-fixture";

// #6990: one request-history rebuild on a 2.34 GB ledger froze the proxy for
// 487 s. This drives a cold rebuild through the real server and measures the
// event loop, /healthz and a routing-time health read while it runs.

const LEDGER_ROWS = 120_000;
// Generous for loaded CI runners; the synchronous rebuild held the loop for the
// whole rebuild (about 1 s for this ledger on a fast laptop, longer on CI).
const LAG_BOUND_MS = 300;
const PROBE_BOUND_MS = 1_000;

let previousHome: string | undefined;
let configDir = "";
let fixture: ManagementServerFixture | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  configDir = mkdtempSync(join(tmpdir(), "ocx-history-responsive-"));
  // A local OpenAI-compatible upstream, so proxied requests complete end to end.
  const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-local",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "m1",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })}\n\n`;
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(
      chunk({ role: "assistant", content: "ok" }, null)
        + chunk({}, "stop", { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })
        + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    ),
  });
});

afterEach(async () => {
  setRequestHistoryStepObserverForTests(null);
  await fixture?.close();
  fixture = null;
  upstream?.stop(true);
  upstream = null;
  await settleServerAuthFixture(configDir);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(configDir);
});

function config(): OcxConfig {
  const baseUrl = `http://127.0.0.1:${upstream!.port}/v1`;
  return currentServerFixtureConfig({
    port: 0,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl, apiKey: "ka", models: ["m1"], allowPrivateNetwork: true },
      b: { adapter: "openai-chat", baseUrl, apiKey: "kb", models: ["m2"], allowPrivateNetwork: true },
    },
    routingProfiles: {
      healthy: {
        candidates: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
  });
}

function writeLedger(): void {
  const now = Date.now();
  const lines: string[] = [];
  for (let index = 0; index < LEDGER_ROWS; index++) {
    lines.push(JSON.stringify({
      requestId: `r-${index}`,
      timestamp: now - 60_000 - index,
      provider: index % 2 === 0 ? "b" : "a",
      model: index % 2 === 0 ? "m2" : "m1",
      status: index % 13 === 0 ? 502 : 200,
      durationMs: 100 + (index % 900),
      usageStatus: "reported",
      usage: { inputTokens: 1000, outputTokens: 200 },
      totalTokens: 1200,
      surface: "codex",
      conversationId: `c-${index % 300}`,
    }));
  }
  writeFileSync(usageLogPath(), `${lines.join("\n")}\n`);
}

test("a cold request-history rebuild leaves /healthz and routing responsive", async () => {
  fixture = await startManagementServerFixture(configDir, config());
  writeLedger();
  const base = `http://127.0.0.1:${fixture.server.port}`;

  let rebuilding = true;
  let inFlight = "none";
  // Attribution only: the longest rebuild steps with their phase, so a hosted
  // failure shows whether its gap was rebuild work or something outside it.
  const longSteps: Array<{ phase: string; ms: number; atMs: number }> = [];
  setRequestHistoryStepObserverForTests((sample: RequestHistoryStepSample) => {
    if (sample.ms < 50) return;
    longSteps.push({ phase: sample.phase, ms: Math.round(sample.ms), atMs: Math.round(sample.startedAt - startedAt) });
    longSteps.sort((left, right) => right.ms - left.ms);
    longSteps.length = Math.min(longSteps.length, 5);
  });

  // Event-loop lag: the largest gap between consecutive 2 ms timers. Each large
  // gap also records the process CPU used inside it, the probe in flight and
  // its start offset; these are diagnostics, the bound stays on wall time.
  let monitoring = true;
  let maxLagMs = 0;
  let maxBusyMs = 0;
  const gaps: Array<{ gapMs: number; cpuMs: number; startMs: number; probe: string }> = [];
  let last = performance.now();
  let lastCpu = process.cpuUsage();
  const monitor = () => {
    const at = performance.now();
    const cpu = process.cpuUsage();
    const gapMs = at - last - 2;
    const cpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
    // Other threads can add CPU too, so the main thread ran at most the gap.
    const busyMs = Math.min(Math.max(gapMs, 0), cpuMs);
    maxLagMs = Math.max(maxLagMs, gapMs);
    maxBusyMs = Math.max(maxBusyMs, busyMs);
    if (gapMs >= 50) {
      gaps.push({ gapMs: Math.round(gapMs), cpuMs: Math.round(cpuMs), startMs: Math.round(last - startedAt), probe: inFlight });
      gaps.sort((left, right) => right.gapMs - left.gapMs);
      gaps.length = Math.min(gaps.length, 5);
    }
    last = at;
    lastCpu = cpu;
    if (monitoring) setTimeout(monitor, 2);
  };
  setTimeout(monitor, 2);

  const startedAt = performance.now();
  // The dashboard history read waits for the rebuild (async reader contract).
  const history = fetch(`${base}/api/request-history?limit=1`, { headers: managementHeaders() })
    .finally(() => { rebuilding = false; });
  // A failed probe ends the test before this settles; teardown must not report it unhandled.
  history.catch(() => undefined);

  const probes = { healthz: [] as number[], dryRun: [] as number[], proxied: [] as number[] };
  // Include latencies that cross publication, using each probe's own start snapshot.
  const startedProbes = { healthz: [] as number[], dryRun: [] as number[], proxied: [] as number[] };
  while (rebuilding) {
    const healthzStartedWhileRebuilding = rebuilding;
    let at = performance.now();
    inFlight = "healthz";
    const healthz = await fetch(`${base}/healthz`);
    expect(healthz.status).toBe(200);
    await healthz.arrayBuffer();
    let latencyMs = performance.now() - at;
    if (rebuilding) probes.healthz.push(latencyMs);
    if (healthzStartedWhileRebuilding) startedProbes.healthz.push(latencyMs);

    // Policy dry-run reads candidate health through the routing-time sync entry.
    const dryRunStartedWhileRebuilding = rebuilding;
    at = performance.now();
    inFlight = "dryRun";
    const dryRun = await fetch(`${base}/api/routing-profiles/dry-run`, {
      method: "POST",
      headers: managementHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ profile: "healthy" }),
    });
    expect(dryRun.status).toBe(200);
    await dryRun.arrayBuffer();
    latencyMs = performance.now() - at;
    if (rebuilding) probes.dryRun.push(latencyMs);
    if (dryRunStartedWhileRebuilding) startedProbes.dryRun.push(latencyMs);

    // A proxied request routed by the policy profile: routing reads candidate
    // health through the sync entry, then dispatches to the local upstream.
    const proxiedStartedWhileRebuilding = rebuilding;
    at = performance.now();
    inFlight = "proxied";
    const proxied = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "policy/healthy", messages: [{ role: "user", content: "ping" }] }),
    });
    const proxiedText = await proxied.text();
    expect(proxied.status, proxiedText).toBe(200);
    latencyMs = performance.now() - at;
    if (rebuilding) probes.proxied.push(latencyMs);
    if (proxiedStartedWhileRebuilding) startedProbes.proxied.push(latencyMs);
  }
  inFlight = "none";
  const response = await history;
  const rebuildMs = performance.now() - startedAt;
  monitoring = false;

  expect(response.status).toBe(200);
  const body = await response.json() as { entries: unknown[]; index: { indexedRows: number; lastError: string | null } };
  expect(body.index.indexedRows).toBe(LEDGER_ROWS);
  expect(body.entries.length).toBe(1);

  const detail = JSON.stringify({
    rebuildMs: Math.round(rebuildMs),
    maxLagMs: Math.round(maxLagMs),
    maxBusyMs: Math.round(maxBusyMs),
    gaps,
    longSteps,
    healthz: probes.healthz.length,
    dryRun: probes.dryRun.length,
    proxied: probes.proxied.length,
  });
  // Requests completed while the rebuild was still unfinished. The synchronous
  // implementation answered none: the rebuild owned the loop until it returned.
  expect(probes.healthz.length, detail).toBeGreaterThanOrEqual(5);
  expect(probes.dryRun.length, detail).toBeGreaterThanOrEqual(5);
  expect(probes.proxied.length, detail).toBeGreaterThanOrEqual(5);
  expect(Math.max(...startedProbes.healthz), detail).toBeLessThan(PROBE_BOUND_MS);
  expect(Math.max(...startedProbes.dryRun), detail).toBeLessThan(PROBE_BOUND_MS);
  expect(Math.max(...startedProbes.proxied), detail).toBeLessThan(PROBE_BOUND_MS);
  expect(maxLagMs, detail).toBeLessThan(LAG_BOUND_MS);
}, 120_000);
