import { expect, test } from "bun:test";
import { codexWsUpgradeReasoningHeaders, CODEX_WS_METADATA_MAX_BYTES, CODEX_WS_METADATA_MAX_VALUE_BYTES } from "../../src/server/responses/codex-ws-metadata";
import { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import { prepareCodexWsRequest, CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";

const usage = { input_tokens: 17, output_tokens: 3, total_tokens: 20 };

async function fixture(options: { flag?: string; before?: string; after?: string; retain?: boolean },
  check: (exchange: () => Promise<Response>, session: CodexWsSession, sends: () => number) => Promise<void>) {
  let sends = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const headers = new Headers({ "set-cookie": "fixture-cookie=private", authorization: "fixture-secret" });
      if (options.flag !== undefined) headers.set("x-reasoning-included", options.flag);
      if (server.upgrade(request, { headers })) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(socket) {
        const id = `fixture-response-${++sends}`;
        const metadata = (flag: string) => socket.send(JSON.stringify({ type: "codex.response.metadata",
          headers: { "x-reasoning-included": flag } }));
        if (options.before !== undefined) metadata(options.before);
        socket.send(JSON.stringify({ type: "response.created", response: { id } }));
        if (options.after !== undefined) metadata(options.after);
        socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [], usage } }));
      },
    },
  });
  const session = new CodexWsSession(`ws://127.0.0.1:${server.port}`, {}, options.retain ?? false);
  const init = { method: "POST", body: JSON.stringify({ model: "fixture", stream: true, input: [] }) };
  const prepared = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, init)!;
  const exchange = async () => {
    expect(session.reserve()).toBe(true);
    return codexWsExchange({ session, url: CODEX_RESPONSES_HTTP_URL, init, prepared,
      sseFallback: (async () => { throw new Error("unexpected fallback"); }) as typeof fetch });
  };
  try { await check(exchange, session, () => sends); }
  finally { session.dispose(); await server.stop(true); }
}

test("real Bun upgrade-only reasoning flag reaches HTTP headers without changing terminal usage", async () => {
  await fixture({ flag: "true" }, async (exchange, _session, sends) => {
    const response = await exchange();
    const body = await response.text();
    expect(response.headers.get("x-reasoning-included")).toBe("true");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("authorization")).toBe(false);
    expect(body).toContain(JSON.stringify(usage));
    expect(body).not.toContain("codex.response.metadata");
    expect(sends()).toBe(1);
  });
});

test.each([undefined, "false"])("missing/false upgrade signal remains %s", async flag => {
  await fixture({ flag }, async exchange => {
    const response = await exchange();
    await response.text();
    expect(response.headers.get("x-reasoning-included")).toBe(flag ?? null);
  });
});

test("prelude metadata overrides the upgrade signal", async () => {
  await fixture({ flag: "true", before: "false" }, async exchange => {
    const response = await exchange();
    expect(response.headers.get("x-reasoning-included")).toBe("false");
    expect(await response.text()).toContain('"x-reasoning-included":"false"');
  });
});

test("late metadata stays in the stream without rewriting committed headers", async () => {
  await fixture({ flag: "true", after: "false" }, async exchange => {
    const response = await exchange();
    expect(await response.text()).toContain('"x-reasoning-included":"false"');
    expect(response.headers.get("x-reasoning-included")).toBe("true");
  });
});

test("retained connection keeps the handshake signal without carrying prior exchange overrides", async () => {
  await fixture({ flag: "true", after: "false", retain: true }, async (exchange, session, sends) => {
    const first = await exchange();
    await first.text();
    first.headers.set("x-reasoning-included", "caller-mutated");
    const second = await exchange();
    await second.text();
    expect(second.headers.get("x-reasoning-included")).toBe("true");
    expect(session.reused).toBe(true);
    expect(sends()).toBe(2);
    const snapshot = session.reasoningUpgradeHeaders();
    snapshot.set("x-reasoning-included", "mutated");
    expect(session.reasoningUpgradeHeaders().get("x-reasoning-included")).toBe("true");
    session.dispose();
    expect([...session.reasoningUpgradeHeaders()]).toEqual([]);
  });
});

// Upgrade extensions are optional; invalid observations must not fail or replay a turn.
test.each([
  null,
  { statusCode: 403, rawHeaders: ["x-reasoning-included", "true"] },
  { statusCode: 101, rawHeaders: ["x-reasoning-included"] },
  { statusCode: 101, rawHeaders: ["x-reasoning-included", true] },
  { statusCode: 101, rawHeaders: ["x-reasoning-included", "true\r\nunsafe"] },
  { statusCode: 101, rawHeaders: ["x-reasoning-included", "true", "X-Reasoning-Included", "false"] },
  { statusCode: 101, rawHeaders: ["x-reasoning-included", "x".repeat(CODEX_WS_METADATA_MAX_VALUE_BYTES + 1)] },
  { statusCode: 101, rawHeaders: ["other", "x".repeat(CODEX_WS_METADATA_MAX_BYTES), "x-reasoning-included", "true"] },
  { statusCode: 101, rawHeaders: Array.from({ length: 129 }, () => ["other", "value"]).flat() },
])("ignores malformed/over-budget upgrade observation %#", data => {
  expect([...codexWsUpgradeReasoningHeaders(data)]).toEqual([]);
});

test("upgrade projection carries only the connection reasoning signal", () => {
  const headers = codexWsUpgradeReasoningHeaders({ statusCode: 101, rawHeaders: [
    "X-Reasoning-Included", "true", "set-cookie", "private", "authorization", "private",
    "x-request-id", "first-turn-only", "x-codex-primary-used-percent", "77",
  ] });
  expect(Object.fromEntries(headers)).toEqual({ "x-reasoning-included": "true" });
});
