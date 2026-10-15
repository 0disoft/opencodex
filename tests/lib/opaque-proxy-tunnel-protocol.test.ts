import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import net from "node:net";
import { dialTunnel, type OpaqueProxyRoute, type OpaqueTunnelOptions } from "../../src/lib/opaque-proxy-tunnel";
import { deadProxy, digest, echo, listen, readBytes, TunnelFixtureScope, until, wait } from "../helpers/opaque-proxy-tunnel";
import { ca, credentials, origin, protocolProxy, proxyKinds, securedClient } from "../helpers/opaque-proxy-tunnel-protocol";

const scope = new TunnelFixtureScope();
afterEach(() => scope.close());
const dialAllowed = (authority: string, routes: readonly OpaqueProxyRoute[], options: Omit<OpaqueTunnelOptions, "allowTarget"> = {}) =>
  dialTunnel(authority, routes, { ...options, allowTarget: value => value === authority });

for (const kind of proxyKinds) {
  test(`${kind}: real authenticated tunnel carries independently verified opaque target TLS`, async () => {
    const end = await origin(scope); const p = await protocolProxy(scope, kind, { destination: end, fragmented: true });
    const { socket: raw, routeId } = await dialAllowed(end.authority, [p.candidate]); assert.equal(routeId, p.candidate.id);
    const secured = await securedClient(scope, raw); const payload = Buffer.from('origin-only plaintext marker\0\xff'); await echo(secured, payload);
    assert.equal(p.seen.auth, 1); assert.deepEqual(p.seen.targets, [{ host: 'origin.fixture.invalid', port: end.port }]);
    assert.deepEqual(Buffer.concat(end.received), payload);
    assert.equal(Buffer.concat(p.seen.opaque).includes(payload), false, 'proxy must see encrypted target data');
    assert.equal(Buffer.concat(end.received).includes(Buffer.from('Proxy-Authorization')), false);
  }, 7000);
  test(`${kind}: explicit dead route falls back before establishment`, async () => {
    const end = await origin(scope), p = await protocolProxy(scope, kind, { destination: end });
    const { socket, routeId } = await dialAllowed(end.authority, [await deadProxy(kind), p.candidate]); scope.own(socket);
    assert.equal(routeId, p.candidate.id); assert.equal(p.seen.handshakes, 1);
  }, 5000);
  test(`${kind}: authentication refusal cannot switch to a backup`, async () => {
    const denied = await protocolProxy(scope, kind, { mode: 'refuse' }), backup = await protocolProxy(scope, kind, { mode: 'hang' });
    await assert.rejects(dialAllowed('origin.fixture.invalid:443', [denied.candidate, backup.candidate]), error => {
      assert.equal((error as { retryable: boolean }).retryable, false);
      const diagnostic = String(error) + JSON.stringify(error);
      assert.equal(diagnostic.includes(credentials.username), false);
      assert.equal(diagnostic.includes(credentials.password), false);
      assert.equal(diagnostic.includes(Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")), false);
      return true;
    });
    assert.equal(backup.seen.connections, 0); await until(() => denied.sockets.size === 0);
  }, 5000);
  test(`${kind}: no-response per-attempt timeout may try explicit backup`, async () => {
    const end = await origin(scope), hung = await protocolProxy(scope, kind, { mode: 'hang' }), backup = await protocolProxy(scope, kind, { destination: end });
    const result = await dialAllowed(end.authority, [hung.candidate, backup.candidate], { timeoutMs: 200 }); scope.own(result.socket);
    assert.equal(result.routeId, backup.candidate.id); await until(() => hung.sockets.size === 0);
  }, 5000);
  test(`${kind}: partial response timeout is terminal`, async () => {
    const p = await protocolProxy(scope, kind, { mode: 'partial' }), backup = await protocolProxy(scope, kind, { mode: 'hang' });
    await assert.rejects(dialAllowed('origin.fixture.invalid:443', [p.candidate, backup.candidate], { timeoutMs: 150 }), error => !(error as { retryable: boolean }).retryable);
    assert.equal(backup.seen.connections, 0); await until(() => p.sockets.size === 0);
  }, 5000);
  test(`${kind}: overall deadline stops the route chain and closes sockets`, async () => {
    const one = await protocolProxy(scope, kind, { mode: 'hang' }), two = await protocolProxy(scope, kind, { mode: 'hang' }), three = await protocolProxy(scope, kind, { mode: 'hang' });
    const start = performance.now();
    await assert.rejects(dialAllowed('origin.fixture.invalid:443', [one.candidate, two.candidate, three.candidate], { timeoutMs: 300, totalTimeoutMs: 500 }), { code: 'TOTAL_TIMEOUT' });
    assert.ok(performance.now() - start < 2_000); assert.equal(one.seen.connections, 1); assert.equal(two.seen.connections, 1); assert.equal(three.seen.connections, 0);
    await until(() => one.sockets.size === 0 && two.sockets.size === 0);
  }, 5000);
  test(`${kind}: caller cancellation cannot switch routes`, async () => {
    const p = await protocolProxy(scope, kind, { mode: 'hang' }), backup = await protocolProxy(scope, kind, { mode: 'hang' }), controller = new AbortController();
    const result = dialAllowed('origin.fixture.invalid:443', [p.candidate, backup.candidate], { signal: controller.signal });
    const assertion = assert.rejects(result, { code: 'ABORTED' }); await until(() => p.seen.handshakes === 1); controller.abort(); await assertion;
    assert.equal(backup.seen.connections, 0); await until(() => p.sockets.size === 0);
  }, 5000);
  test(`${kind}: target TLS 2 MiB backpressure and half-close preserve bytes`, async () => {
    const end = await origin(scope, { slow: true }), p = await protocolProxy(scope, kind, { destination: end });
    const { socket } = await dialAllowed(end.authority, [p.candidate]); const secured = await securedClient(scope, socket);
    const payload = Buffer.alloc(2 * 1024 * 1024); for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    await echo(secured, payload, true); assert.equal(digest(Buffer.concat(end.received)), digest(payload));
  }, 12000);
  test(`${kind}: failure after opaque target TLS and application bytes never replays`, async () => {
    const end = await origin(scope, { drop: true }), p = await protocolProxy(scope, kind, { destination: end }), backup = await protocolProxy(scope, kind, { mode: 'hang' });
    const { socket } = await dialAllowed(end.authority, [p.candidate, backup.candidate]); const secured = await securedClient(scope, socket);
    const closed = new Promise<void>(resolve => { secured.once('end', resolve); secured.once('close', resolve); secured.once('error', () => resolve()); });
    const payload = Buffer.from('single-committed-operation'); secured.write(payload); secured.resume(); await closed; secured.destroy();
    assert.deepEqual(Buffer.concat(end.received), payload); assert.equal(end.calls(), 1); assert.equal(backup.seen.connections, 0);
  }, 5000);
}

for (const mode of ['untrusted', 'wrong-name']) {
  test(`HTTPS proxy ${mode} certificate is terminal and cannot fall back`, async () => {
    const p = await protocolProxy(scope, 'https', { mode: 'hang' }), backup = await protocolProxy(scope, 'http', { mode: 'hang' });
    assert.equal(p.candidate.kind, 'https');
    if (p.candidate.kind !== 'https') throw new Error('HTTPS fixture required');
    const bad = { ...p.candidate, ...(mode === 'untrusted' ? { proxyCa: undefined } : { proxyServername: 'wrong.fixture.invalid' }) };
    await assert.rejects(dialAllowed('origin.fixture.invalid:443', [bad, backup.candidate]), error => (error as { code: string }).code === 'PROXY_TLS' && !(error as { retryable: boolean }).retryable);
    assert.equal(backup.seen.connections, 0); await until(() => p.sockets.size === 0);
  }, 5000);
}
test('target TLS certificate still rejects a wrong hostname through a verified HTTPS proxy', async () => {
  const end = await origin(scope), p = await protocolProxy(scope, 'https', { destination: end });
  const { socket } = await dialAllowed(end.authority, [p.candidate]);
  await assert.rejects(securedClient(scope, socket, 'wrong.fixture.invalid'), /certificate|hostname|altnames/i);
}, 5000);
for (const kind of ['socks5', 'socks5h'] as const) {
  test(`${kind}: early opaque bytes beyond 64 KiB survive CONNECT response coalescing`, async () => {
    const p = await protocolProxy(scope, kind, { mode: 'early-large' });
    const { socket } = await dialAllowed('origin.fixture.invalid:443', [p.candidate]); scope.own(socket);
    assert.deepEqual(await readBytes(socket, 192 * 1024), Buffer.alloc(192 * 1024, 0xa5));
  }, 5000);
  test(`${kind}: explicit SOCKS policy refusal never falls back`, async () => {
    const p = await protocolProxy(scope, kind, { mode: 'policy' }), backup = await protocolProxy(scope, 'http', { mode: 'hang' });
    await assert.rejects(dialAllowed('origin.fixture.invalid:443', [p.candidate, backup.candidate]), { code: 'SOCKS_REFUSED', retryable: false });
    assert.equal(backup.seen.connections, 0);
  }, 5000);
}
test('stalled HTTPS proxy TLS handshake is bounded, terminal, and cancellable', async () => {
  const plain = await protocolProxy(scope, 'http', { mode: 'hang' }), backup = await protocolProxy(scope, 'http', { mode: 'hang' });
  const candidate = { id: plain.candidate.id, kind: 'https' as const, host: '127.0.0.1', port: plain.candidate.port, proxyCa: ca, proxyServername: 'proxy.fixture.invalid' };
  await assert.rejects(dialAllowed('origin.fixture.invalid:443', [candidate, backup.candidate], { timeoutMs: 60 }), error => (error as { code: string }).code === 'TIMEOUT' && !(error as { retryable: boolean }).retryable);
  assert.equal(backup.seen.connections, 0); await until(() => plain.sockets.size === 0);
  const abort = new AbortController(), pending = dialAllowed('origin.fixture.invalid:443', [candidate], { signal: abort.signal });
  const assertion = assert.rejects(pending, { code: 'ABORTED' }); await until(() => plain.seen.connections === 2); abort.abort(); await assertion; await until(() => plain.sockets.size === 0);
}, 5000);
test('configuration rejects unsupported protocols and invalid credential sizes before dialing', async () => {
  const route = { id: 'x', host: '127.0.0.1', port: 1 };
  await assert.rejects(dialAllowed('origin.fixture.invalid:443', [{ ...route, kind: 'direct' } as unknown as OpaqueProxyRoute]), { code: 'CONFIG' });
  await assert.rejects(dialAllowed('origin.fixture.invalid:443', [{ ...route, kind: 'socks5', username: 'x'.repeat(256), password: 'p' }]), { code: 'CONFIG' });
  await assert.rejects(dialAllowed('origin.fixture.invalid:443', [{ ...route, kind: 'socks5h', username: 'u', password: '' }]), { code: 'CONFIG' });
  await assert.rejects(dialAllowed('origin.fixture.invalid:443', [route], { totalTimeoutMs: 0 }), { code: 'CONFIG' });
});


for (const kind of ["http", "https"] as const) {
  test(`${kind}: revoked target authorization during connection sends no CONNECT or credentials`, async () => {
    let authorized = true;
    const proxy = await protocolProxy(scope, kind, { mode: "hang", onAccepted: () => { authorized = false; } });
    const backup = await protocolProxy(scope, "http", { mode: "hang" });
    const authority = "origin.fixture.invalid:443";
    await assert.rejects(dialTunnel(authority, [proxy.candidate, backup.candidate], {
      allowTarget: value => value === authority && authorized,
    }), { code: "TARGET", retryable: false });
    assert.equal(proxy.seen.connections, 1);
    assert.equal(proxy.seen.applicationBytes, 0);
    assert.equal(proxy.seen.auth, 0);
    assert.equal(proxy.seen.targets.length, 0);
    assert.equal(backup.seen.connections, 0);
    await until(() => proxy.sockets.size === 0);
  }, 5_000);
}

for (const kind of ["socks5", "socks5h"] as const) {
  for (const phase of ["credentials", "target"] as const) {
    test(`${kind}: revocation before ${phase} write fails closed`, async () => {
      let authorized = true, stage = 0;
      const received: Buffer[] = [];
      const server = net.createServer(socket => {
        let pending = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          received.push(chunk);
          pending = Buffer.concat([pending, chunk]);
          if (stage === 0 && pending.length >= 4) {
            assert.deepEqual([...pending], [5, 2, 0, 2]);
            pending = Buffer.alloc(0);
            stage++;
            if (phase === "credentials") authorized = false;
            socket.write(Buffer.from([5, 2]));
          } else if (stage === 1 && pending.length >= 3 + Buffer.byteLength(credentials.username + credentials.password)) {
            assert.equal(pending[0], 1);
            assert.equal(pending.subarray(2, 2 + pending[1]).toString(), credentials.username);
            stage++;
            authorized = false;
            socket.write(Buffer.from([1, 0]));
          }
        });
      });
      const sockets = new Set<net.Socket>();
      const port = await listen(scope, server, sockets);
      const backup = await protocolProxy(scope, "http", { mode: "hang" });
      const authority = "origin.fixture.invalid:443";
      await assert.rejects(dialTunnel(authority, [
        { id: "revoked", kind, host: "127.0.0.1", port, ...credentials }, backup.candidate,
      ], { allowTarget: value => value === authority && authorized }), { code: "TARGET", retryable: false });
      await until(() => sockets.size === 0);
      const all = Buffer.concat(received);
      assert.equal(stage, phase === "credentials" ? 1 : 2);
      assert.equal(all.includes(Buffer.from("origin.fixture.invalid")), false);
      if (phase === "credentials") {
        assert.equal(all.includes(Buffer.from(credentials.username)), false);
        assert.equal(all.includes(Buffer.from(credentials.password)), false);
      }
      assert.equal(backup.seen.connections, 0);
    }, 5_000);
  }
}

for (const kind of proxyKinds) {
  test(`${kind}: after establishment the caller owns cancellation and the socket`, async () => {
    const end = await origin(scope), proxy = await protocolProxy(scope, kind, { destination: end });
    const controller = new AbortController();
    const { socket } = await dialAllowed(end.authority, [proxy.candidate], {
      signal: controller.signal, totalTimeoutMs: 200,
    });
    scope.own(socket);
    assert.equal(socket.isPaused(), true);
    controller.abort();
    // The already-cleared establishment deadline must not destroy caller-owned I/O.
    await wait(250);
    assert.equal(socket.destroyed, false);
    const secured = await securedClient(scope, socket);
    const payload = Buffer.from("caller-owned-after-establishment");
    await echo(secured, payload);
    assert.deepEqual(Buffer.concat(end.received), payload);
  }, 5_000);
}

for (const kind of proxyKinds) {
  test(`${kind}: revocation while awaiting CONNECT success prevents socket handoff`, async () => {
    let authorized = true;
    const end = await origin(scope);
    const proxy = await protocolProxy(scope, kind, {
      destination: end,
      beforeEstablishedReply: () => { authorized = false; },
    });
    const backup = await protocolProxy(scope, "http", { mode: "hang" });
    await assert.rejects(dialTunnel(end.authority, [proxy.candidate, backup.candidate], {
      allowTarget: value => value === end.authority && authorized,
    }), { code: "TARGET", retryable: false });
    assert.equal(proxy.seen.auth, 1);
    assert.deepEqual(proxy.seen.targets, [{ host: "origin.fixture.invalid", port: end.port }]);
    assert.equal(backup.seen.connections, 0);
    assert.equal(end.received.length, 0);
    await until(() => proxy.seen.clientEnds === 1);
  }, 5_000);
}
