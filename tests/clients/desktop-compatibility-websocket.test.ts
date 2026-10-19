import { expect, test } from "bun:test";
import WebSocket, { WebSocketServer } from "desktop-ws";
import { createServer, request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { createServer as tcpServer } from "node:net";
import type { IncomingMessage } from "node:http";
import { createCertificateAuthority, issueServerLeaf } from "../../src/claude/intercept/local-ca";
import { startDesktopRelay } from "../../src/codex/desktop-compatibility/relay-listener";
import { isUsageWebSocketPath, USAGE_WEBSOCKET_MAX_MESSAGE_BYTES, type UsagePushController } from "../../src/codex/desktop-compatibility/usage-websocket-relay";
import { UsageRelayController } from "../../src/codex/desktop-compatibility/usage-controller";
import { listenFixture } from "../helpers/desktop-egress-fixture";

const broker = "/backend-api/pages/realtime-broker/u123/ws";
const account = { id: "fixture-account", userId: "fixture-user", plan: "pro", structure: "personal" } as const;
const usage = { account_id: account.id, user_id: account.userId, plan_type: account.plan,
  rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } }, other: "kept" };
const wire = (value: unknown = usage) => JSON.stringify([{ type: "message", topic_id: "codex-work-usage-push-v1",
  payload: { type: "usage.snapshot", payload: { version: 1, stream_id: "fixture", sequence: 1, generated_at_ms: 1000, usage: value } } }]);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { const limit = Date.now() + 3000; while (!check()) { if (Date.now() > limit) throw new Error("fixture deadline"); await pause(5); } }
const controller = () => new UsageRelayController(account, async () => account, async () => account, () => 1000, 100000);
async function applying() { const owner = controller(); await owner.rewritePushMessage(wire());
  expect((await owner.activate({ scope: "account-ui-compatibility", accountWideConsent: true })).accepted).toBe(true); return owner; }

async function fixture(owner?: UsagePushController, reject?: (req: IncomingMessage, socket: any) => void) {
  const ca = createCertificateAuthority({ commonName: "broker-fixture", validityDays: 1 });
  const leaf = issueServerLeaf(ca, "broker-fixture", ["chatgpt.com", "ws.chatgpt.com"]);
  const origin = createServer({ cert: leaf.certPem, key: leaf.keyPem });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 0,
    handleProtocols: protocols => protocols.has("fixture.v2") ? "fixture.v2" : [...protocols][0] || false });
  const peers: WebSocket[] = [], clients = new Set<WebSocket>(), handshakes: IncomingMessage[] = [];
  origin.on("upgrade", (req, socket, head) => {
    handshakes.push(req);
    if (reject) { reject(req, socket); return; }
    wss.handleUpgrade(req, socket, head, ws => { peers.push(ws); ws.on("error", () => {}); wss.emit("connection", ws, req); });
  });
  wss.on("headers", headers => headers.push("X-Fixture: handshake", "Set-Cookie: one=1; Secure", "Set-Cookie: two=2; Secure"));
  const upstream = await listenFixture(origin);
  const relay = await startDesktopRelay({ leaf, usageController: owner,
    fetchImpl: (async () => new Response("http-fixture")) as typeof fetch,
    websocketPeer: { host: "127.0.0.1", port: upstream.port, ca: ca.certPem }, websocketTransport: { proxy: false } });
  const connect = (host = "chatgpt.com", path = broker, protocols: string[] = []) => {
    const ws = new WebSocket(`wss://127.0.0.1:${relay.port}${path}`, protocols, { ca: ca.certPem, servername: host,
      headers: { host, cookie: "fixture=session", "proxy-authorization": "must-not-leak" }, perMessageDeflate: true, maxPayload: 0 });
    clients.add(ws); ws.on("error", () => {}); return ws;
  };
  return { ca, relay, peers, handshakes, connect, async close() {
    for (const ws of clients) ws.terminate(); await relay.close();
    for (const ws of peers) ws.terminate(); wss.close(); await upstream.close();
    await until(() => [...clients, ...peers].every(ws => ws.readyState === WebSocket.CLOSED));
  } };
}
function collect(ws: WebSocket) { const messages: { data: Buffer; binary: boolean }[] = [];
  ws.on("message", (data, binary) => messages.push({ data: Buffer.from(data as Buffer), binary })); return messages; }

test("only the exact broker path is a message relay", () => {
  expect(isUsageWebSocketPath(broker)).toBe(true);
  for (const path of [broker + "?other=1", broker + "/extra", broker.replace("123", "X"), "/dictation/stream"]) expect(isUsageWebSocketPath(path)).toBe(false);
});

for (const [host, path] of [["chatgpt.com", broker], ["ws.chatgpt.com", broker], ["ws.chatgpt.com", broker + "?opaque=fixture"]]) test(`broker ${host}${path.includes("?") ? " with query" : ""} preserves handshake and changes only verified usage booleans`, async () => {
  const owner = await applying(), f = await fixture(owner);
  try {
    const client = f.connect(host, path, ["fixture.v1", "fixture.v2"]), received = collect(client);
    let headers: IncomingMessage["headers"] | undefined; client.on("upgrade", response => headers = response.headers);
    await until(() => client.readyState === WebSocket.OPEN && f.peers.length === 1);
    expect(client.protocol).toBe("fixture.v2"); expect(client.extensions).toBe("");
    expect(headers?.["x-fixture"]).toBe("handshake"); expect(headers?.["set-cookie"]).toHaveLength(2);
    expect(f.handshakes[0]!.headers.cookie).toBe("fixture=session"); expect(f.handshakes[0]!.headers["proxy-authorization"]).toBeUndefined();
    expect(f.handshakes[0]!.headers["sec-websocket-extensions"]).toBeUndefined();
    expect(f.handshakes[0]!.url).toBe(path);
    expect(owner.snapshot().observation.validatedActiveStreams).toBe(0);
    const untouched = ' \n[{"type":"message","topic_id":"other","payload":{"type":"unknown"}}]\n ';
    f.peers[0]!.send(untouched); f.peers[0]!.send(Buffer.from(wire())); f.peers[0]!.send(wire());
    await until(() => received.length === 3);
    expect(received[0]!.data.toString()).toBe(untouched); expect(received[0]!.binary).toBe(false);
    expect(received[1]).toEqual({ data: Buffer.from(wire()), binary: true });
    const changed = JSON.parse(received[2]!.data.toString())[0].payload.payload.usage;
    expect(changed).toEqual({ ...usage, rate_limit: { ...usage.rate_limit, allowed: true, limit_reached: false } });
    expect(owner.snapshot().observation.validatedActiveStreams).toBe(1);
    const outbound = collect(f.peers[0]!); client.send("client-text"); client.send(Buffer.from([0, 255, 42]));
    await until(() => outbound.length === 2);
    expect(outbound).toEqual([{ data: Buffer.from("client-text"), binary: false }, { data: Buffer.from([0, 255, 42]), binary: true }]);
    let close: { code: number; reason: string } | undefined;
    client.on("close", (code, reason) => close = { code, reason: reason.toString() });
    f.peers[0]!.close(4001, "fixture-close"); await until(() => !!close);
    expect(close).toEqual({ code: 4001, reason: "fixture-close" });
    await until(() => owner.snapshot().trackedStreams === 0);
  } finally { await f.close(); await owner.observeOnly(); }
}, 10000);

test("Ping and Pong cross both legs once, preserving each payload without automatic duplicate Pong", async () => {
  const f = await fixture();
  try {
    const client = f.connect(); await until(() => f.peers.length === 1 && client.readyState === WebSocket.OPEN);
    const peer = f.peers[0]!, peerPings: string[] = [], peerPongs: string[] = [], clientPings: string[] = [], clientPongs: string[] = [];
    peer.on("ping", value => peerPings.push(value.toString())); peer.on("pong", value => peerPongs.push(value.toString()));
    client.on("ping", value => clientPings.push(value.toString())); client.on("pong", value => clientPongs.push(value.toString()));
    client.ping("client-heartbeat"); await until(() => clientPongs.length === 1);
    expect(peerPings).toEqual(["client-heartbeat"]); expect(clientPongs).toEqual(["client-heartbeat"]);
    peer.ping("server-heartbeat"); await until(() => peerPongs.length === 1);
    expect(clientPings).toEqual(["server-heartbeat"]); expect(peerPongs).toEqual(["server-heartbeat"]);
    await pause(20); expect(clientPongs).toHaveLength(1); expect(peerPongs).toHaveLength(1);
  } finally { await f.close(); }
}, 10000);

for (const direction of ["client", "upstream"] as const) test(`${direction} over the finite 100MiB message ceiling closes both legs with 1009`, async () => {
  const f = await fixture();
  try {
    const client = f.connect(), messages = collect(client); await until(() => f.peers.length === 1 && client.readyState === WebSocket.OPEN);
    const peer = f.peers[0]!; let clientCode: number | undefined, peerCode: number | undefined;
    client.on("close", code => clientCode = code); peer.on("close", code => peerCode = code);
    // Header-only invalid-size fixture: ws rejects the declared payload length
    // before allocation, so this tests 100MiB+1 without allocating a 100MiB body.
    const header = Buffer.alloc(direction === "client" ? 14 : 10);
    header[0] = 0x82; header[1] = direction === "client" ? 0xff : 0x7f;
    header.writeBigUInt64BE(BigInt(USAGE_WEBSOCKET_MAX_MESSAGE_BYTES + 1), 2);
    (direction === "client" ? client : peer)._socket.write(header);
    await until(() => clientCode !== undefined && peerCode !== undefined);
    expect(clientCode).toBe(1009); expect(peerCode).toBe(1009); expect(messages).toHaveLength(0);
  } finally { await f.close(); }
}, 10000);

test("awaited rewrites serialize multiple messages, including a final message before peer Close", async () => {
  let unlock!: () => void, started = 0, active = 0, peak = 0;
  const gate = new Promise<void>(resolve => unlock = resolve);
  const owner: UsagePushController = { registerPushStream: () => null, async rewritePushMessage(text) {
    started++; active++; peak = Math.max(peak, active);
    if (text === "one") await gate;
    active--; return text.toUpperCase();
  } };
  const f = await fixture(owner);
  try {
    const client = f.connect(), got = collect(client); await until(() => f.peers.length === 1 && client.readyState === WebSocket.OPEN);
    f.peers[0]!.send("one"); f.peers[0]!.send("two"); f.peers[0]!.send("three"); f.peers[0]!.close(4002, "ordered-end");
    await until(() => started === 1); await pause(30); expect(got).toHaveLength(0); expect(started).toBe(1);
    unlock(); await until(() => got.length === 3 && client.readyState === WebSocket.CLOSED);
    expect(got.map(value => value.data.toString())).toEqual(["ONE", "TWO", "THREE"]); expect(peak).toBe(1);
  } finally { unlock(); await f.close(); }
}, 10000);

test("a shared-topic message larger than the rewrite ceiling remains byte-identical", async () => {
  const owner: UsagePushController = { registerPushStream: () => null,
    async rewritePushMessage(text) { return Buffer.byteLength(text) > 262144 ? null : "small-corrected"; } };
  const f = await fixture(owner);
  try {
    const client = f.connect(), got = collect(client); await until(() => f.peers.length === 1 && client.readyState === WebSocket.OPEN);
    const huge = wire({ ...usage, noise: "x".repeat(300000) });
    f.peers[0]!.send(huge); f.peers[0]!.send(wire()); await until(() => got.length === 2);
    expect(got[0]!.data).toEqual(Buffer.from(huge)); expect(got[1]!.data.toString()).toBe("small-corrected");
  } finally { await f.close(); }
}, 10000);

test("closing during an awaited rewrite releases registration and never sends its late result", async () => {
  let unlock!: () => void, entered = false, releases = 0;
  const gate = new Promise<void>(resolve => unlock = resolve);
  const owner: UsagePushController = {
    registerPushStream: () => ({ bind: () => true, exclude() {}, release() { releases++; } }),
    async rewritePushMessage() { entered = true; await gate; return "late-correction"; },
  };
  const f = await fixture(owner);
  try {
    const client = f.connect(), got = collect(client); await until(() => f.peers.length === 1 && client.readyState === WebSocket.OPEN);
    f.peers[0]!.send("held"); await until(() => entered); client.close(4003, "cancel");
    await until(() => releases > 0 && client.readyState === WebSocket.CLOSED); unlock(); await pause(30); expect(got).toHaveLength(0);
  } finally { unlock(); await f.close(); }
}, 10000);

test("send completion backpressure preserves burst order in both directions", async () => {
  const f = await fixture({ registerPushStream: () => null, async rewritePushMessage() { await pause(1); return null; } });
  try {
    const client = f.connect(), received = collect(client); await until(() => f.peers.length === 1 && client.readyState === WebSocket.OPEN);
    const incoming = collect(f.peers[0]!);
    for (let i = 0; i < 32; i++) {
      const value = Buffer.alloc(65536, i); value.writeUInt32BE(i, 0); client.send(value); f.peers[0]!.send(value);
    }
    await until(() => received.length === 32 && incoming.length === 32);
    for (const messages of [received, incoming]) {
      expect(messages.map(message => message.data.readUInt32BE(0))).toEqual(Array.from({ length: 32 }, (_, i) => i));
      expect(messages.every(message => message.binary && message.data.length === 65536)).toBe(true);
    }
  } finally { await f.close(); }
}, 10000);

test("listener shutdown aborts a pending authenticated proxy dial and closes the owned proxy connection", async () => {
  const ca = createCertificateAuthority({ commonName: "cancel-broker", validityDays: 1 });
  let accepted = false, proxyClosed = false;
  const proxy = await listenFixture(tcpServer(socket => { socket.once("data", () => accepted = true); socket.once("close", () => proxyClosed = true); }));
  const relay = await startDesktopRelay({ leaf: issueServerLeaf(ca, "cancel-broker", ["chatgpt.com"]),
    fetchImpl: (async () => { throw Error("HTTP forbidden"); }) as typeof fetch,
    websocketTransport: { proxy: `http://fixture:secret@127.0.0.1:${proxy.port}`, timeoutMs: 2000 } });
  const client = new WebSocket(`wss://127.0.0.1:${relay.port}${broker}`, { ca: ca.certPem, servername: "chatgpt.com", headers: { host: "chatgpt.com" } });
  client.on("error", () => {});
  try {
    await until(() => accepted); const start = Date.now(); await relay.close(); await until(() => proxyClosed);
    expect(Date.now() - start).toBeLessThan(1500); expect(client.readyState).toBe(WebSocket.CLOSED);
  } finally { client.terminate(); await relay.close(); await proxy.close(); }
}, 10000);

test("only a verified usage stream becomes a controller refresh target", async () => {
  const owner = controller(), f = await fixture(owner);
  try {
    const unrelated = f.connect(), bound = f.connect(); collect(unrelated); collect(bound);
    await until(() => f.peers.length === 2 && unrelated.readyState === WebSocket.OPEN && bound.readyState === WebSocket.OPEN);
    f.peers[0]!.send('[{"type":"message","topic_id":"other"}]'); f.peers[1]!.send(wire());
    await until(() => owner.snapshot().observation.validatedActiveStreams === 1);
    const result = await owner.activate({ scope: "account-ui-compatibility", accountWideConsent: true });
    expect(result.accepted).toBe(true); await until(() => bound.readyState === WebSocket.CLOSED); expect(unrelated.readyState).toBe(WebSocket.OPEN);
  } finally { await f.close(); await owner.observeOnly(); }
}, 10000);

test("upstream handshake rejection preserves status, headers and chunked body without sending 101", async () => {
  const f = await fixture(undefined, (_req, socket) => socket.end("HTTP/1.1 429 Fixture Limit\r\nX-Fixture: refusal\r\nRetry-After: 7\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n7\r\nlimited\r\n0\r\n\r\n"));
  try {
    const client = f.connect(); let result: { status?: number; body: string; retry?: string } | undefined;
    client.on("unexpected-response", (_req, res) => { const chunks: Buffer[] = []; res.on("data", bytes => chunks.push(bytes));
      res.on("end", () => result = { status: res.statusCode, body: Buffer.concat(chunks).toString(), retry: res.headers["retry-after"] }); });
    await until(() => !!result); expect(result).toEqual({ status: 429, body: "limited", retry: "7" });
  } finally { await f.close(); }
}, 10000);

test("ws.chatgpt.com HTTP receives 421; foreign hosts, ports and non-origin upgrade paths never dial", async () => {
  const f = await fixture();
  try {
    const httpStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpsRequest({ hostname: "127.0.0.1", port: f.relay.port, servername: "ws.chatgpt.com", ca: f.ca.certPem,
        path: "/backend-api/wham/usage", headers: { host: "ws.chatgpt.com" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); }); req.on("error", reject); req.end();
    });
    expect(httpStatus).toBe(421);
    for (const [host, path] of [["evil.test", broker], ["chatgpt.com:444", broker], ["ws.chatgpt.com.evil", broker],
      ["chatgpt.com", "//evil.test/path"], ["chatgpt.com", "/\\evil.test/path"]]) {
      const actual = await new Promise<string>((resolve, reject) => {
        const socket = tlsConnect({ host: "127.0.0.1", port: f.relay.port, servername: "chatgpt.com", ca: f.ca.certPem });
        let bytes = ""; socket.on("error", reject); socket.on("data", chunk => bytes += chunk.toString()); socket.on("end", () => { socket.destroy(); resolve(bytes); });
        socket.on("secureConnect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: Zml4dHVyZS1rZXktMTIzNA==\r\n\r\n`));
      });
      expect(actual).toContain("421 Misdirected Request");
    }
    expect(f.handshakes).toHaveLength(0);
  } finally { await f.close(); }
}, 10000);
