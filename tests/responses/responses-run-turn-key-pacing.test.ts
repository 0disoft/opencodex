import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { handleResponses } from "../../src/server/responses";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test.each([false, true])("runTurn refresh releases the old key and readmits the replacement (abort=%s)", async abortWhileWaiting => {
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-runturn-pacing-"));
  process.env.OPENCODEX_HOME = home;
  resetProviderRequestPacingForTest();
  const releaseOwner = acquireOwnedSpendHome();
  const seen: string[] = [];
  const create = ADAPTER_REGISTRY["openai-chat"].create;
  const override = spyOn(ADAPTER_REGISTRY["openai-chat"], "create").mockImplementation((...args) => ({
    ...create(...args),
    async runTurn(_parsed, _incoming, emit) {
      seen.push(args[0].apiKey!);
      emit({ type: "text_delta", text: "readmitted turn" }); emit({ type: "done" });
    },
  }));
  const config = { port: 0, defaultProvider: "paced", providers: { paced: {
    adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key", apiKey: "synthetic-first",
    apiKeyPool: [{ id: "first", key: "synthetic-first" }, { id: "second", key: "synthetic-second" }],
    requestPacing: { enabled: true, keys: { maxConcurrentRequests: 1 } },
  } } } as OcxConfig;
  const first = await waitForProviderRequestSlot("paced", config.providers.paced);
  const second = await waitForProviderRequestSlot("paced", { ...config.providers.paced, apiKey: "synthetic-second" });
  const abort = new AbortController();
  let pending: Promise<Response> | undefined;
  const waitForKeyQueue = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      if (providerRequestPacingStatus("paced", config.providers.paced).keys?.find(key => key.id === id)?.queued === 1) return;
      await Bun.sleep(5);
    }
    throw new Error(`key ${id} never queued`);
  };
  try {
    pending = handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
      body: JSON.stringify({ model: "paced/test", input: "hello", stream: false }),
    }), config, { provider: "", model: "" }, { abortSignal: abort.signal });
    // Observe any rejected handler immediately while the test controls its queue.
    void pending.catch(() => {});
    await waitForKeyQueue("first");
    config.providers.paced.apiKey = "synthetic-second";
    config.providers.paced.apiKeySelectionRevision = "replacement";
    first.release();
    await waitForKeyQueue("second");
    expect(seen).toEqual([]);
    expect(providerRequestPacingStatus("paced", config.providers.paced).keys?.find(key => key.id === "first")?.inFlight).toBe(0);
    if (abortWhileWaiting) {
      abort.abort();
      await pending.catch(() => undefined);
      expect(seen).toEqual([]);
      expect(providerRequestPacingStatus("paced", config.providers.paced).queued).toBe(0);
    } else {
      second.release();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("readmitted turn");
      expect(seen).toEqual(["synthetic-second"]);
    }
  } finally {
    abort.abort(); first.release(); second.release();
    await pending?.catch(() => undefined);
    override.mockRestore(); resetProviderRequestPacingForTest(); releaseOwner(); removeTreeWithRetry(home);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  }
});
