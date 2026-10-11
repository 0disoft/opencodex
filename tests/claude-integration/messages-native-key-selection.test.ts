import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { captureProviderApiKeySelection } from "../../src/providers/api-key-selection";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, recordDistributedKeyFailure } from "../../src/providers/key-failover";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const NAME = "native-key-selection";
const KEYS = ["fixture-key-alpha", "fixture-key-beta", "fixture-key-gamma"];
const MESSAGE = { id: "msg_key_selection", type: "message", role: "assistant", model: "claude-x",
  content: [{ type: "text", text: "fixture reply" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 3 } };
let home: string;
let previousHome: string | undefined;
let releaseOwner: () => void;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let seen: { key: string | null; path: string; body: unknown }[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-native-key-selection-"));
  process.env.OPENCODEX_HOME = home;
  releaseOwner = acquireOwnedSpendHome();
  clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
  seen = [];
});

afterEach(async () => {
  await upstream?.stop(true); upstream = undefined;
  releaseOwner();
  clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function fixture(count = 2, rejectFirst = false, keyCap = true): OcxConfig {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    seen.push({ key: req.headers.get("x-api-key"), path: new URL(req.url).pathname, body: await req.json() });
    if (rejectFirst && seen.length === 1) return Response.json({ type: "error",
      error: { type: "authentication_error", message: "invalid fixture key" } }, { status: 401 });
    return Response.json(MESSAGE);
  } });
  const config = { port: 0, defaultProvider: NAME, protocols: { rollout: { managedMessagesNative: true } },
    providers: { [NAME]: { adapter: "anthropic", baseUrl: `http://127.0.0.1:${upstream.port}`,
      authMode: "key", allowPrivateNetwork: true, apiKey: KEYS[0], apiKeySelectionRevision: "saved-revision",
      models: ["claude-x"], apiKeyPool: KEYS.slice(0, count).map((key, index) => ({ id: `k${index + 1}`, key, addedAt: index + 1 })),
      requestPacing: { enabled: true, keySelection: "round-robin",
        ...(keyCap ? { keys: { maxConcurrentRequests: 1 } } : { maxConcurrentRequests: 1 }) },
    } } } as OcxConfig;
  saveConfig(config);
  return config;
}

function provider(config: OcxConfig): OcxProviderConfig { return config.providers[NAME]!; }
function status(config: OcxConfig) { return providerRequestPacingStatus(NAME, provider(config)); }
function keyStatus(config: OcxConfig, id: string) { return status(config).keys!.find(key => key.id === id)!; }
function cool(config: OcxConfig, index: number): void {
  const selection = { ...captureProviderApiKeySelection({ ...provider(config), apiKey: KEYS[index] }), distributed: true };
  expect(recordDistributedKeyFailure(config, NAME, selection, 429, Date.now(), "30")).toBe(true);
}
async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(5);
  }
}
function queue(config: OcxConfig, id: string) {
  return waitUntil(() => keyStatus(config, id).queued === 1, `key ${id} never queued: ${JSON.stringify(status(config))}`);
}
function start(config: OcxConfig, abort: AbortController) {
  const requestId = `native-key-selection-${crypto.randomUUID()}`;
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
  const pending = handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST",
    headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model: `${NAME}/claude-x`, max_tokens: 64,
      messages: [{ role: "user", content: "fixture question" }], stream: false }),
  }), config, { model: "", provider: "" }, { requestId, start: Date.now() })
    .then(async response => ({ response, text: await response.text(), requestId }));
  void pending.catch(() => {});
  return pending;
}
function unchanged(config: OcxConfig) {
  expect(provider(config).apiKey).toBe(KEYS[0]);
  expect(provider(config).apiKeySelectionRevision).toBe("saved-revision");
  const persisted = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
  expect(persisted.providers[NAME]!.apiKey).toBe(KEYS[0]);
  expect(persisted.providers[NAME]!.apiKeySelectionRevision).toBe("saved-revision");
  expect(persisted.providers[NAME]!._apiKeyAttempt).toBeUndefined();
}
function noLeaks(config: OcxConfig) {
  expect(status(config)).toMatchObject({ queued: 0, inFlight: 0 });
  for (const key of status(config).keys!) expect(key).toMatchObject({ queued: 0, inFlight: 0 });
}
function nativeSuccess(result: Awaited<ReturnType<typeof start>>) {
  expect(result.response.status).toBe(200);
  expect(JSON.parse(result.text).content).toEqual(MESSAGE.content);
  expect(getRequestLogEntries().find(row => row.requestId === result.requestId)?.protocolTrace?.mode).toBe("native");
  expect(seen.every(entry => entry.path === "/v1/messages")).toBe(true);
}

describe("native Messages distributed key selection", () => {
  test("401 recovers A to B without changing the saved key or revision", async () => {
    const config = fixture(2, true);
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      nativeSuccess(await pending);
      expect(seen.map(entry => entry.key)).toEqual(KEYS.slice(0, 2));
      expect(seen[1]!.body).toEqual(seen[0]!.body);
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); await pending.catch(() => undefined); }
  });

  for (const cancel of [false, true]) test(`cooled queued A releases its permit and readmits B (abort=${cancel})`, async () => {
    const config = fixture();
    const first = await waitForProviderRequestSlot(NAME, provider(config));
    const second = await waitForProviderRequestSlot(NAME, { ...provider(config), apiKey: KEYS[1] });
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      await queue(config, "k1");
      expect(seen).toEqual([]);
      cool(config, 0); first.release();
      await queue(config, "k2");
      expect(first.released).toBe(true);
      expect(keyStatus(config, "k1")).toMatchObject({ inFlight: 0, queued: 0, starts: 2 });
      expect(keyStatus(config, "k2")).toMatchObject({ inFlight: 1, queued: 1, starts: 1 });
      expect(status(config).inFlight).toBe(1);
      expect(seen).toEqual([]);
      if (cancel) {
        abort.abort();
        await pending.catch(() => undefined);
        expect(seen).toEqual([]);
        expect(status(config).queued).toBe(0);
        second.release();
      } else {
        second.release(); nativeSuccess(await pending);
        expect(seen.map(entry => entry.key)).toEqual([KEYS[1]]);
      }
      unchanged(config); noLeaks(config);
    } finally {
      abort.abort(); first.release(); second.release(); await pending.catch(() => undefined);
    }
  }, 10_000);

  test("round-robin without a keys rule reselects behind the provider concurrency cap", async () => {
    const config = fixture(2, false, false);
    expect(provider(config).requestPacing!.keys).toBeUndefined();
    const held = await waitForProviderRequestSlot(NAME, provider(config));
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      await queue(config, "k1"); cool(config, 0);
      expect(seen).toEqual([]);
      held.release(); nativeSuccess(await pending);
      expect(seen.map(entry => entry.key)).toEqual([KEYS[1]]);
      expect(keyStatus(config, "k1").starts).toBe(2);
      expect(keyStatus(config, "k2").starts).toBe(1);
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); held.release(); await pending.catch(() => undefined); }
  });

  for (const exhausted of [false, true]) test(`revalidates B after readmission when B cools while queued (exhausted=${exhausted})`, async () => {
    const config = fixture(3);
    const first = await waitForProviderRequestSlot(NAME, provider(config));
    const second = await waitForProviderRequestSlot(NAME, { ...provider(config), apiKey: KEYS[1] });
    const abort = new AbortController();
    const pending = start(config, abort);
    try {
      await queue(config, "k1"); cool(config, 0); first.release();
      await queue(config, "k2");
      expect(keyStatus(config, "k1").inFlight).toBe(0);
      expect(seen).toEqual([]);
      cool(config, 1);
      if (exhausted) cool(config, 2);
      second.release();
      const result = await pending;
      if (exhausted) {
        expect(result.response.status).toBe(429);
        expect(Number(result.response.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(seen).toEqual([]);
      } else {
        nativeSuccess(result);
        expect(seen.map(entry => entry.key)).toEqual([KEYS[2]]);
      }
      unchanged(config); noLeaks(config);
    } finally { abort.abort(); first.release(); second.release(); await pending.catch(() => undefined); }
  }, 10_000);
});
