import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { createOwnedIngressManager } from "../../src/lib/opaque-proxy-lifecycle/managed-session";
import type { GenerationLease } from "../../src/lib/opaque-proxy-lifecycle/owner-manager";
import type { OpaqueProxyRoute } from "../../src/lib/opaque-proxy-tunnel";
import { deadProxy, echo, listen, readBytes, TunnelFixtureScope, until } from "../helpers/opaque-proxy-tunnel";
import { ca, origin, protocolProxy, proxyKinds, securedClient } from "../helpers/opaque-proxy-tunnel-protocol";

const scope = new TunnelFixtureScope();
afterEach(() => scope.close());
const capability = "Basic " + Buffer.from("session:synthetic-full-tls-integration-capability").toString("base64");

async function session(authority: string, candidates: readonly OpaqueProxyRoute[], sessionMs = 5000) {
  const owner = {};
  const manager = createOwnedIngressManager({ owner, candidates, allowTarget: value => value === authority,
    ingress: { sessionMs, totalMs: 5000, idleMs: 3000, establishMs: 2000 },
    manager: { sessionMs: 10000, startupMs: 2000, shutdownMs: 2000 } });
  scope.after(() => manager.shutdown(owner));
  const lease = await manager.start(owner, { authorized: true, authorization: capability });
  return { owner, manager, lease };
}

function connectHead(authority: string, authorization = capability): Buffer {
  return Buffer.from(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${authorization}\r\n\r\n`);
}

async function responseHead(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0);
    const cleanup = () => { socket.pause(); socket.off("data", data); socket.off("error", fail); socket.off("end", ended); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const ended = () => fail(new Error("CONNECT response ended before headers"));
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) { if (buffer.length > 8192) fail(new Error("oversized fixture response")); return; }
      cleanup();
      if (buffer.length > end + 4) socket.unshift(buffer.subarray(end + 4));
      resolve(buffer.subarray(0, end).toString("latin1"));
    };
    socket.on("data", data); socket.once("error", fail); socket.once("end", ended); socket.resume();
  });
}

async function connectClient(lease: GenerationLease, authority: string, authorization = capability) {
  const socket = scope.own(net.connect({ host: lease.host, port: lease.port, allowHalfOpen: true }));
  await once(socket, "connect");
  const head = responseHead(socket); socket.write(connectHead(authority, authorization));
  return { socket, header: await head };
}

/** A test-only CONNECT client bridge. It strips only CONNECT's 200 response;
 * all following bytes, including ClientHello, remain encrypted and untouched.
 */
async function eagerTlsClient(lease: GenerationLease, authority: string) {
  let earlyBytes = 0;
  const server = net.createServer({ allowHalfOpen: true }, client => {
    client.on("error", () => {});
    client.once("data", (first: Buffer) => {
      client.pause(); earlyBytes = first.length;
      void (async () => {
        assert.equal(first[0], 0x16, "first coalesced bytes are a genuine TLS handshake record");
        const upstream = scope.own(net.connect({ host: lease.host, port: lease.port, allowHalfOpen: true }));
        client.once("error", () => upstream.destroy());
        upstream.once("error", () => client.destroy());
        client.once("close", () => { if (!client.readableEnded) upstream.destroy(); });
        upstream.once("close", () => { if (!upstream.readableEnded) client.destroy(); });
        await once(upstream, "connect");
        const head = responseHead(upstream);
        // One write deliberately coalesces the local CONNECT head and ClientHello.
        upstream.write(Buffer.concat([connectHead(authority), first]));
        assert.match(await head, /^HTTP\/1\.1 200 /);
        client.pipe(upstream); upstream.pipe(client);
      })().catch(error => client.destroy(error instanceof Error ? error : undefined));
    });
  });
  const port = await listen(scope, server);
  const options = { host: "127.0.0.1", port, servername: "origin.fixture.invalid", ca, rejectUnauthorized: true, allowHalfOpen: true };
  const socket = scope.own(tls.connect(options));
  await once(socket, "secureConnect"); assert.equal(socket.authorized, true); assert.ok(earlyBytes > 0);
  return { socket, earlyBytes };
}

for (const kind of proxyKinds) {
  test(`managed ${kind}: approved fallback plus coalesced ClientHello preserves verified TLS and half-close`, async () => {
    const end = await origin(scope, { slow: true });
    const proxy = await protocolProxy(scope, kind, { destination: end, fragmented: true });
    const x = await session(end.authority, [await deadProxy(kind), proxy.candidate]);
    // A second start must reuse the same generation/port without duplicating listeners.
    assert.equal(await x.manager.start(x.owner, { authorized: true, authorization: capability }), x.lease);
    const { socket } = await eagerTlsClient(x.lease, end.authority);
    const payload = Buffer.alloc(1024 * 1024); for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    await echo(socket, payload, true);
    assert.deepEqual(Buffer.concat(end.received), payload);
    assert.equal(proxy.seen.auth, 1); assert.equal(proxy.seen.connections, 1); assert.equal(end.calls(), 1);
    assert.equal(Buffer.concat(proxy.seen.opaque).includes(payload.subarray(0, 256)), false);
    assert.equal(Buffer.concat(end.received).includes(Buffer.from(capability)), false);
    await x.manager.stop(x.owner); assert.equal(x.manager.status().state, "stopped");
    await until(() => proxy.sockets.size === 0);
  }, 10000);

  test(`managed ${kind}: wrong capability sends no handshake; stop closes an active target TLS session`, async () => {
    const end = await origin(scope), proxy = await protocolProxy(scope, kind, { destination: end });
    const x = await session(end.authority, [proxy.candidate]);
    const denied = await connectClient(x.lease, end.authority, "Basic invalid-fixture");
    assert.match(denied.header, /^HTTP\/1\.1 407 /); denied.socket.destroy();
    assert.equal(proxy.seen.connections, 0); assert.equal(end.calls(), 0);
    const accepted = await connectClient(x.lease, end.authority); assert.match(accepted.header, /^HTTP\/1\.1 200 /);
    const secure = await securedClient(scope, accepted.socket);
    const payload = Buffer.from("one-unreplayed-operation"); const answer = readBytes(secure, payload.length); secure.write(payload);
    assert.deepEqual(await answer, payload);
    const closed = new Promise<void>(resolve => { secure.once("close", resolve); secure.once("end", resolve); }); secure.resume();
    await x.manager.stop(x.owner); await closed;
    assert.equal(x.manager.status().state, "stopped"); assert.equal(proxy.seen.connections, 1);
    assert.equal(end.calls(), 1); assert.deepEqual(Buffer.concat(end.received), payload);
    await until(() => proxy.seen.clientEnds === 1);
    await until(() => proxy.sockets.size === 0);
  }, 7000);
}

for (const kind of ["https", "socks5h"] as const) {
  test(`managed ${kind}: session expiry closes target TLS without reconnect or replay`, async () => {
    const end = await origin(scope), proxy = await protocolProxy(scope, kind, { destination: end });
    const x = await session(end.authority, [proxy.candidate], 600);
    const accepted = await connectClient(x.lease, end.authority); assert.match(accepted.header, /^HTTP\/1\.1 200 /);
    const secure = await securedClient(scope, accepted.socket);
    const payload = Buffer.from("expiry-operation"); const answer = readBytes(secure, payload.length); secure.write(payload); assert.deepEqual(await answer, payload);
    const closed = new Promise<void>(resolve => { secure.once("close", resolve); secure.once("end", resolve); }); secure.resume();
    await closed; await until(() => x.manager.status().state === "stopped");
    await until(() => proxy.sockets.size === 0);
    assert.equal(proxy.seen.connections, 1); assert.equal(end.calls(), 1); assert.deepEqual(Buffer.concat(end.received), payload);
  }, 5000);
}

test("managed HTTPS: untrusted proxy certificate is rejected before origin or fallback", async () => {
  const end = await origin(scope), proxy = await protocolProxy(scope, "https", { destination: end });
  const backup = await protocolProxy(scope, "http", { destination: end });
  assert.equal(proxy.candidate.kind, "https");
  const bad = { ...proxy.candidate, proxyCa: undefined } as OpaqueProxyRoute;
  const x = await session(end.authority, [bad, backup.candidate]);
  const accepted = await connectClient(x.lease, end.authority);
  assert.match(accepted.header, /^HTTP\/1\.1 502 /); accepted.socket.destroy();
  assert.equal(backup.seen.connections, 0); assert.equal(end.calls(), 0);
}, 5000);

test("managed HTTPS: target hostname verification remains mandatory through the full session", async () => {
  const end = await origin(scope), proxy = await protocolProxy(scope, "https", { destination: end });
  const x = await session(end.authority, [proxy.candidate]);
  const accepted = await connectClient(x.lease, end.authority); assert.match(accepted.header, /^HTTP\/1\.1 200 /);
  await assert.rejects(securedClient(scope, accepted.socket, "wrong.fixture.invalid"), /certificate|hostname|altnames/i);
  assert.equal(proxy.seen.connections, 1); assert.equal(end.received.length, 0);
}, 5000);
