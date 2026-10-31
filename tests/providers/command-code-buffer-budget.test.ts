import { expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import type { AdapterEvent } from "../../src/types";

const adapter = () => createCommandCodeAdapter({ adapter: "command-code", baseUrl: "https://command.example" });
const content = "é한😀".repeat(32);
const line = JSON.stringify({ type: "text-delta", text: content });
const encoder = new TextEncoder();

function input(bytes: Uint8Array, chunkSize: number) {
  let offset = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body), cancelled: () => cancelled };
}

for (const ending of ["\n", ""] as const) {
  for (const fragmented of [false, true]) {
    test(`Command Code admits an exact-limit ${fragmented ? "fragmented" : "whole"} record with ${JSON.stringify(ending)} termination`, async () => {
      const bytes = encoder.encode(line + ending);
      const budget = createTestTranslatorBudget({ maxTurnBytes: bytes.length });
      const source = input(bytes, fragmented ? 1 : bytes.length);
      const events: AdapterEvent[] = [];
      for await (const event of adapter().parseStream(source.response, budget)) events.push(event);
      expect(events).toEqual([
        { type: "text_delta", text: content },
        { type: "done", usage: undefined, stopReason: undefined },
      ]);
      expect(budget.snapshot()).toMatchObject({ currentBytes: 0, highWaterBytes: bytes.length, overflows: 0 });
    });
  }
}

for (const fragmented of [false, true]) {
  test(`Command Code refuses a ${fragmented ? "fragmented" : "whole"} record one byte over budget and cleans up`, async () => {
    const bytes = encoder.encode(line);
    const budget = createTestTranslatorBudget({ maxTurnBytes: bytes.length - 1 });
    const source = input(bytes, fragmented ? 1 : bytes.length);
    const events: AdapterEvent[] = [];
    const consume = async () => {
      for await (const event of adapter().parseStream(source.response, budget)) events.push(event);
    };
    await expect(consume()).rejects.toMatchObject({ code: "translation_buffer_limit", kind: "live_transient" });
    expect(events).toHaveLength(0);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, overflows: 1 });
    expect(source.cancelled()).toBe(true);
  });
}

test("Command Code buffer replacement preserves another owner's retained bytes", async () => {
  const bytes = encoder.encode(line);
  const budget = createTestTranslatorBudget({ maxTurnBytes: bytes.length + 64 });
  budget.chargeRetained(64, { kind: "retained_collectors" });
  for await (const _event of adapter().parseStream(input(bytes, 1).response, budget)) { /* drain */ }
  expect(budget.snapshot()).toMatchObject({ currentBytes: 64, highWaterBytes: bytes.length + 64, overflows: 0 });
  budget.releaseRetained(64, { kind: "retained_collectors" });
  expect(budget.snapshot().currentBytes).toBe(0);
});

test("Command Code consumer return releases its retained record and cancels upstream", async () => {
  const bytes = encoder.encode(line + "\n");
  const budget = createTestTranslatorBudget({ maxTurnBytes: bytes.length });
  const source = input(bytes, bytes.length);
  const events = adapter().parseStream(source.response, budget);
  expect((await events.next()).value).toMatchObject({ type: "text_delta", text: content });
  expect(budget.snapshot().currentBytes).toBe(bytes.length);
  await events.return();
  expect(budget.snapshot().currentBytes).toBe(0);
  expect(source.cancelled()).toBe(true);
});
