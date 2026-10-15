import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { dialTunnel, type OpaqueProxyRoute, type OpaqueTunnelOptions } from "../../src/lib/opaque-proxy-tunnel";
import {
  allowTarget, deadProxy, digest, echo, httpProxy, listen, readBytes,
  target, TunnelFixtureScope, until, wait,
} from "../helpers/opaque-proxy-tunnel";

const scope = new TunnelFixtureScope();
afterEach(() => scope.close());

test("refused first proxy falls back to an explicit second and opaque bytes round-trip", async () => {
  const dead = await deadProxy(), live = await httpProxy(scope);
  const { socket, routeId } = await dialTunnel(target, [dead, live.candidate], { allowTarget });
  scope.own(socket);
  assert.equal(routeId, live.candidate.id);
  const expected = Buffer.from([0, 255, 1, 127, 13, 10]);
  const reply = readBytes(socket, expected.length);
  socket.write(expected);
  assert.deepEqual(await reply, expected);
  assert.equal(live.seen.calls, 1);
}, 5_000);

test("all failed candidates surface ALL_FAILED without a direct destination connection", async () => {
  const dead = await deadProxy(), dead2 = await deadProxy();
  let directCalls = 0;
  const destination = net.createServer(socket => { directCalls++; socket.destroy(); });
  const port = await listen(scope, destination);
  const authority = `127.0.0.1:${port}`;
  await assert.rejects(dialTunnel(authority, [dead, dead2], { allowTarget: value => value === authority }), { code: "ALL_FAILED" });
  assert.equal(directCalls, 0);
}, 5_000);

for (const mode of ["407", "403", "malformed", "oversize"] as const) {
  test(`${mode} is terminal and never contacts a backup`, async () => {
    const refused = await httpProxy(scope, mode), backup = await httpProxy(scope);
    await assert.rejects(dialTunnel(target, [refused.candidate, backup.candidate], { allowTarget }), error => {
      const failure = error as { code: string; status?: number };
      assert.equal(failure.code, mode === "407" || mode === "403" ? "REFUSED" : "PROTOCOL");
      if (mode === "407" || mode === "403") assert.equal(failure.status, Number(mode));
      return true;
    });
    assert.equal(backup.seen.calls, 0);
    await until(() => refused.sockets.size === 0);
  }, 5_000);
}

for (const mode of ["bad-header", "partial-refusal", "partial-timeout"] as const) {
  test(`${mode} fails closed without contacting backup`, async () => {
    const proxy = await httpProxy(scope, mode), backup = await httpProxy(scope);
    await assert.rejects(dialTunnel(target, [proxy.candidate, backup.candidate], { allowTarget, timeoutMs: 150 }), { retryable: false });
    assert.equal(backup.seen.calls, 0);
    await until(() => proxy.sockets.size === 0);
  }, 5_000);
}

test("establishment timeout falls back and destroys the hanging first socket", async () => {
  const hang = await httpProxy(scope, "hang"), backup = await httpProxy(scope);
  const result = await dialTunnel(target, [hang.candidate, backup.candidate], { allowTarget, timeoutMs: 150 });
  scope.own(result.socket);
  assert.equal(result.routeId, backup.candidate.id);
  assert.equal(backup.seen.calls, 1);
  await until(() => hang.sockets.size === 0);
}, 5_000);

test("caller cancellation closes establishment and never tries backup", async () => {
  const hang = await httpProxy(scope, "hang"), backup = await httpProxy(scope), controller = new AbortController();
  const pending = dialTunnel(target, [hang.candidate, backup.candidate], { allowTarget, signal: controller.signal, timeoutMs: 2_000 });
  const check = assert.rejects(pending, { code: "ABORTED" });
  await until(() => hang.seen.calls === 1);
  controller.abort();
  await check;
  assert.equal(backup.seen.calls, 0);
  await until(() => hang.sockets.size === 0);
}, 5_000);

test("already-cancelled request opens no proxy connection", async () => {
  const proxy = await httpProxy(scope), controller = new AbortController();
  controller.abort();
  await assert.rejects(dialTunnel(target, [proxy.candidate], { allowTarget, signal: controller.signal }), { code: "ABORTED" });
  assert.equal(proxy.seen.calls, 0);
  assert.equal(proxy.sockets.size, 0);
}, 5_000);

test("early opaque bytes coalesced with CONNECT headers are preserved", async () => {
  const proxy = await httpProxy(scope, "banner");
  const { socket } = await dialTunnel(target, [proxy.candidate], { allowTarget });
  scope.own(socket);
  const payload = Buffer.from("early-client-bytes");
  const received = readBytes(socket, 13 + payload.length);
  socket.write(payload);
  assert.deepEqual(await received, Buffer.concat([Buffer.from("opaque-banner"), payload]));
  assert.deepEqual(Buffer.concat(proxy.seen.payloads), payload);
}, 5_000);

test("caller half-close preserves a 4 MiB echoed response under backpressure", async () => {
  const proxy = await httpProxy(scope, "slow");
  const { socket } = await dialTunnel(target, [proxy.candidate], { allowTarget });
  scope.own(socket);
  const payload = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  await echo(socket, payload, true);
  assert.equal(proxy.seen.bytes, payload.length);
  assert.equal(digest(Buffer.concat(proxy.seen.payloads)), digest(payload));
}, 12_000);

test("failure after establishment and application bytes never reconnects or replays", async () => {
  const drop = await httpProxy(scope, "drop"), backup = await httpProxy(scope);
  const { socket } = await dialTunnel(target, [drop.candidate, backup.candidate], { allowTarget });
  scope.own(socket);
  const ended = once(socket, "end");
  socket.write("unique-turn-payload");
  socket.resume();
  await ended;
  socket.end();
  assert.equal(drop.seen.bytes, 19);
  assert.equal(drop.seen.calls, 1);
  assert.equal(backup.seen.calls, 0);
}, 5_000);

for (const policy of ["denies", "throws", "async"] as const) {
  test(`target policy ${policy} fails closed before any proxy connection`, async () => {
    const proxy = await httpProxy(scope);
    const allow = policy === "denies" ? () => false
      : policy === "throws" ? () => { throw new Error("private policy context"); }
      : async () => true;
    await assert.rejects(dialTunnel(target, [proxy.candidate], {
      allowTarget: allow as OpaqueTunnelOptions["allowTarget"],
    }), error => {
      assert.equal((error as { code: string }).code, "TARGET");
      assert.equal(String(error).includes("private policy context"), false);
      return true;
    });
    assert.equal(proxy.seen.calls, 0);
    assert.equal(proxy.sockets.size, 0);
  }, 5_000);
}

test("configuration requires explicit candidates and a synchronous target policy", async () => {
  const route: OpaqueProxyRoute = { id: "proxy", host: "127.0.0.1", port: 1 };
  await assert.rejects(dialTunnel(target, [], { allowTarget }), { code: "CONFIG" });
  await assert.rejects(dialTunnel(target, [route], {} as OpaqueTunnelOptions), { code: "TARGET" });
  await assert.rejects(dialTunnel(target, [route], undefined as unknown as OpaqueTunnelOptions), { code: "TARGET" });
});

test("authorization is rechecked before opening the next physical candidate", async () => {
  const first = await httpProxy(scope, "hang"), backup = await httpProxy(scope);
  let authorized = true;
  const result = dialTunnel(target, [first.candidate, backup.candidate], {
    allowTarget: authority => authority === target && authorized,
    timeoutMs: 200,
  });
  const check = assert.rejects(result, { code: "TARGET", retryable: false });
  await until(() => first.seen.calls === 1);
  authorized = false;
  await check;
  assert.equal(backup.seen.calls, 0);
  assert.equal(backup.sockets.size, 0);
  await until(() => first.sockets.size === 0);
}, 5_000);

test("rejecting asynchronous target policy is denied without an unhandled rejection", async () => {
  const proxy = await httpProxy(scope);
  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", observe);
  try {
    const policy = async () => { throw new Error("private fixture context"); };
    await assert.rejects(dialTunnel(target, [proxy.candidate], {
      allowTarget: policy as unknown as OpaqueTunnelOptions["allowTarget"],
    }), error => {
      assert.equal((error as { code: string }).code, "TARGET");
      assert.equal((String(error) + JSON.stringify(error)).includes("private fixture context"), false);
      return true;
    });
    // Allow the rejected policy promise to cross a complete event-loop turn.
    await wait(10);
    assert.deepEqual(unhandled, []);
    assert.equal(proxy.seen.calls, 0);
    assert.equal(proxy.sockets.size, 0);
  } finally {
    process.removeListener("unhandledRejection", observe);
  }
}, 5_000);
