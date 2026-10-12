import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // Event-loop lag: the largest gap between consecutive 2 ms timers.
  let monitoring = true;
  let maxLagMs = 0;
  let last = performance.now();
  const monitor = () => {
    const at = performance.now();
    maxLagMs = Math.max(maxLagMs, at - last - 2);
    last = at;
    if (monitoring) setTimeout(monitor, 2);
  };
  setTimeout(monitor, 2);

  let rebuilding = true;
  const startedAt = performance.now();
  // The dashboard history read waits for the rebuild (async reader contract).
  const history = fetch(`${base}/api/request-history?limit=1`, { headers: managementHeaders() })
    .finally(() => { rebuilding = false; });
  // A failed probe ends the test before this settles; teardown must not report it unhandled.
  history.catch(() => undefined);

  const probes = { healthz: [] as number[], dryRun: [] as number[], proxied: [] as number[] };
  while (rebuilding) {
    let at = performance.now();
    const healthz = await fetch(`${base}/healthz`);
    expect(healthz.status).toBe(200);
    await healthz.arrayBuffer();
    if (rebuilding) probes.healthz.push(performance.now() - at);

    // Policy dry-run reads candidate health through the routing-time sync entry.
    at = performance.now();
    const dryRun = await fetch(`${base}/api/routing-profiles/dry-run`, {
      method: "POST",
      headers: managementHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ profile: "healthy" }),
    });
    expect(dryRun.status).toBe(200);
    await dryRun.arrayBuffer();
    if (rebuilding) probes.dryRun.push(performance.now() - at);

    // A proxied request routed by the policy profile: routing reads candidate
    // health through the sync entry, then dispatches to the local upstream.
    at = performance.now();
    const proxied = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "policy/healthy", messages: [{ role: "user", content: "ping" }] }),
    });
    const proxiedText = await proxied.text();
    expect(proxied.status, proxiedText).toBe(200);
    if (rebuilding) probes.proxied.push(performance.now() - at);
  }
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
    healthz: probes.healthz.length,
    dryRun: probes.dryRun.length,
    proxied: probes.proxied.length,
  });
  // Requests completed while the rebuild was still unfinished. The synchronous
  // implementation answered none: the rebuild owned the loop until it returned.
  expect(probes.healthz.length, detail).toBeGreaterThanOrEqual(5);
  expect(probes.dryRun.length, detail).toBeGreaterThanOrEqual(5);
  expect(probes.proxied.length, detail).toBeGreaterThanOrEqual(5);
  expect(Math.max(...probes.healthz), detail).toBeLessThan(PROBE_BOUND_MS);
  expect(Math.max(...probes.dryRun), detail).toBeLessThan(PROBE_BOUND_MS);
  expect(Math.max(...probes.proxied), detail).toBeLessThan(PROBE_BOUND_MS);
  expect(maxLagMs, detail).toBeLessThan(LAG_BOUND_MS);
}, 120_000);
