import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer as createHttps } from "node:https";
import { createServer as createTcp, type Socket } from "node:net";
import { dialDesktopUpstream } from "../../src/lib/desktop-upstream-tunnel";
import { desktopProxyFor } from "../../src/lib/desktop-proxy-route";
import { createOwnedIngressManager } from "../../src/lib/opaque-proxy-lifecycle/managed-session";
import { createCertificateAuthority, issueServerLeaf } from "../../src/claude/intercept/local-ca";
import { forwardProxy, listenFixture } from "../helpers/desktop-egress-fixture";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test("desktop HTTP and WS choose explicit NO_PROXY, supported proxies, or a closed failure", () => {
  const url = new URL("https://chatgpt.com/");
  expect(desktopProxyFor(url, {})).toBe(false);
  expect(desktopProxyFor(url, { HTTPS_PROXY: "http://127.0.0.1:4444" })).toBe("http://127.0.0.1:4444");
  expect(desktopProxyFor(url, { ALL_PROXY: "http://127.0.0.1:4444" })).toBe("http://127.0.0.1:4444");
  expect(desktopProxyFor(url, { all_proxy: "https://127.0.0.1:4444" })).toBe("https://127.0.0.1:4444");
  expect(desktopProxyFor(url, { HTTPS_PROXY: "http://127.0.0.1:4444", ALL_PROXY: "http://127.0.0.1:5555" })).toBe("http://127.0.0.1:4444");
  expect(() => desktopProxyFor(url, { HTTPS_PROXY: "bad", ALL_PROXY: "http://127.0.0.1:5555" })).toThrow("proxy_invalid");
  expect(desktopProxyFor(url, { HTTPS_PROXY: "http://127.0.0.1:4444", NO_PROXY: "chatgpt.com" })).toBe(false);
  expect(desktopProxyFor(url, { HTTPS_PROXY: "http://127.0.0.1:4444", ALL_PROXY: "socks5://127.0.0.1:5555" })).toBe("socks5://127.0.0.1:5555");
  expect(() => desktopProxyFor(url, { HTTPS_PROXY: "ftp://127.0.0.1:4444" })).toThrow("proxy_invalid");
  expect(() => desktopProxyFor(url, { HTTPS_PROXY: "http://127.0.0.1:4444/path" })).toThrow("proxy_invalid");
});

for (const kind of ["http", "https", "socks5", "socks5h"] as const) test(`verified TLS through authenticated ${kind} proxy preserves raw request and response`, async () => {
  const ca = createCertificateAuthority({ commonName: "egress-fixture", validityDays: 1 });
  const leaf = issueServerLeaf(ca, "egress-fixture", ["chatgpt.com"]), proxyLeaf = issueServerLeaf(ca, "egress-fixture", ["localhost"]);
  let cookie: string | undefined, leaked: string | undefined;
  const upstream = createHttps({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    cookie = req.headers.cookie; leaked = req.headers["proxy-authorization"] as string | undefined;
    res.end("fixture-response");
  });
  const transport = kind === "socks5h" ? "socks5" : kind;
  const origin = await listenFixture(upstream), proxy = await forwardProxy(transport, origin.port, proxyLeaf);
  let socket: Awaited<ReturnType<typeof dialDesktopUpstream>> | undefined;
  try {
    socket = await dialDesktopUpstream({ proxy: proxy.url.replace(/^socks5:/, `${kind}:`), ca: ca.certPem, proxyCa: ca.certPem, target: { host: "chatgpt.com", port: 443 } });
    assert.equal(socket.authorized, true);
    const response = new Promise<string>((resolve, reject) => {
      let text = ""; socket!.on("data", bytes => { text += bytes.toString(); }); socket!.once("end", () => resolve(text)); socket!.once("error", reject);
    });
    socket.write("GET /fixture HTTP/1.1\r\nHost: chatgpt.com\r\nCookie: fixture=session\r\nConnection: close\r\n\r\n");
    expect(await response).toContain("fixture-response"); expect(cookie).toBe("fixture=session"); expect(leaked).toBeUndefined();
    expect(proxy.seen).toHaveLength(1); expect(proxy.seen[0]!.authority).toBe("chatgpt.com:443");
    expect(proxy.seen[0]!.auth).toBe(transport === "socks5" ? "fixture:secret" : "Basic " + Buffer.from("fixture:secret").toString("base64"));
  } finally { socket?.destroy(); await proxy.close(); await origin.close(); }
}, 15000);

for (const kind of ["http", "https", "socks5", "http-all", "https-all"] as const) test(`desktop HTTP fetch uses the same authenticated ${kind} egress and validates upstream TLS`, async () => {
  const ca = createCertificateAuthority({ commonName: "fetch-egress-fixture", validityDays: 1 });
  const leaf = issueServerLeaf(ca, "fetch-egress-fixture", ["chatgpt.com"]), proxyLeaf = issueServerLeaf(ca, "fetch-egress-fixture", ["localhost"]);
  let actual: Buffer | undefined;
  const upstream = createHttps({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
      actual = Buffer.concat(chunks); res.end("fixture-fetch-response");
    });
  });
  const transport = kind === "http-all" ? "http" : kind === "https-all" ? "https" : kind;
  const origin = await listenFixture(upstream), proxy = await forwardProxy(transport, origin.port, proxyLeaf);
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-fetch-")), certificate = join(root, "fixture-ca.pem");
  writeFileSync(certificate, ca.certPem);
  // Windows environment names are case-insensitive: ALL_PROXY and all_proxy are ONE variable, so
  // giving them different values left the winner to env-block ordering, and an unrelated new
  // variable once flipped it and sent this child straight to the real chatgpt.com. Clear every
  // spelling, then set only the routes this case means.
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(name)));
  Object.assign(env, { NODE_EXTRA_CA_CERTS: certificate }, kind.endsWith("-all") ? { ALL_PROXY: proxy.url } : { HTTPS_PROXY: proxy.url });
  const child = Bun.spawn([process.execPath, repoPath("tests/helpers/desktop-egress-worker.ts")], {
    cwd: repoRoot(), stdout: "pipe", stderr: "pipe", env,
  });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [exitCode, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, error }).toEqual({ exitCode: 0, error: "" });
    expect(JSON.parse(output)).toEqual({ status: 200, body: "fixture-fetch-response" });
    expect(actual).toEqual(Buffer.from([0, 255, 42])); expect(proxy.seen).toHaveLength(1);
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } await proxy.close(); await origin.close(); removeTreeWithRetry(root); }
}, 15000);

test("untrusted proxy TLS is refused without reaching the target", async () => {
  const ca = createCertificateAuthority({ commonName: "untrusted-proxy", validityDays: 1 });
  const leaf = issueServerLeaf(ca, "untrusted-proxy", ["localhost"]);
  const proxy = await forwardProxy("https", 1, leaf);
  try { await expect(dialDesktopUpstream({ proxy: proxy.url, timeoutMs: 1000 })).rejects.toThrow("desktop_upstream_connection_failed"); expect(proxy.seen).toHaveLength(0); }
  finally { await proxy.close(); }
});

test("trusted certificates with wrong proxy or upstream hostnames are still refused", async () => {
  const ca = createCertificateAuthority({ commonName: "wrong-host-fixture", validityDays: 1 });
  const wrongProxy = await forwardProxy("https", 1, issueServerLeaf(ca, "wrong-host-fixture", ["chatgpt.com"]));
  try {
    await expect(dialDesktopUpstream({ proxy: wrongProxy.url, proxyCa: ca.certPem, timeoutMs: 1000 })).rejects.toThrow("desktop_upstream_connection_failed");
    expect(wrongProxy.seen).toHaveLength(0);
  } finally { await wrongProxy.close(); }
  const wrongLeaf = issueServerLeaf(ca, "wrong-host-fixture", ["localhost"]);
  const upstream = await listenFixture(createHttps({ cert: wrongLeaf.certPem, key: wrongLeaf.keyPem }));
  const proxy = await forwardProxy("http", upstream.port, wrongLeaf);
  try { await expect(dialDesktopUpstream({ proxy: proxy.url, ca: ca.certPem, timeoutMs: 1000 })).rejects.toThrow("desktop_upstream_connection_failed"); }
  finally { await proxy.close(); await upstream.close(); }
});

for (const failure of ["eof", "oversized", "timeout", "abort"] as const) test(`proxy ${failure} failure settles and closes the owned connection`, async () => {
  let closed!: () => void, accepted!: () => void;
  const closedEvent = new Promise<void>(resolve => { closed = resolve; }), acceptedEvent = new Promise<void>(resolve => { accepted = resolve; });
  const server = createTcp(socket => {
    socket.once("close", closed); socket.once("data", () => {
      accepted();
      if (failure === "eof") socket.end();
      if (failure === "oversized") socket.write(Buffer.alloc(65537, 65));
    });
  });
  const proxy = await listenFixture(server), abort = new AbortController();
  try {
    const dial = dialDesktopUpstream({ proxy: `http://127.0.0.1:${proxy.port}`, timeoutMs: failure === "abort" ? 2000 : 500, signal: abort.signal });
    const settled = dial.then(() => null, error => error as Error);
    await acceptedEvent; if (failure === "abort") abort.abort();
    const at = Date.now(), result = await settled;
    expect(result?.message).toBe("desktop_upstream_connection_failed");
    if (failure === "abort") expect(Date.now() - at).toBeLessThan(500);
    await closedEvent;
  } finally { await proxy.close(); }
}, 3000);

/** Read exactly one fixture HTTP response while keeping its verified TLS connection alive. */
function fixtureRequest(socket: Socket, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes: Buffer = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer); socket.off("data", receive); socket.off("error", fail);
      socket.off("end", ended); socket.off("close", ended);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const ended = () => fail(new Error("Fixture response closed before Content-Length bytes arrived"));
    const receive = (chunk: Buffer) => {
      try {
        bytes = Buffer.concat([bytes, chunk]);
        assert.ok(bytes.length <= 65536, "fixture response is bounded");
        const end = bytes.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = bytes.subarray(0, end).toString("latin1");
        assert.match(head, /^HTTP\/1\.1 200 /);
        const length = /\r\ncontent-length: ([0-9]+)(?:\r\n|$)/i.exec(head);
        assert.ok(length, "fixture response declares Content-Length");
        const expected = end + 4 + Number(length[1]);
        assert.ok(bytes.length <= expected, "one request receives exactly one response");
        if (bytes.length === expected) { cleanup(); resolve(bytes.subarray(end + 4).toString("utf8")); }
      } catch (error) { fail(error as Error); }
    };
    const timer = setTimeout(() => fail(new Error("Fixture response deadline exceeded")), 2000);
    socket.on("data", receive); socket.once("error", fail); socket.once("end", ended); socket.once("close", ended);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: chatgpt.com\r\nCookie: fixture=session\r\nConnection: keep-alive\r\n\r\n`);
  });
}

function socketClosed(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const closed = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      socket.off("close", closed);
      reject(new Error(`Shutdown did not close the consumer socket (readableEnded=${socket.readableEnded}, writableEnded=${socket.writableEnded}, destroyed=${socket.destroyed}, allowHalfOpen=${socket.allowHalfOpen})`));
    }, 2000);
    socket.once("close", closed);
  });
}

for (const kind of ["socks5", "socks5h"] as const) for (const credentials of [
  { username: "fixture:colon", password: "secret" },
  { username: "", password: "secret" },
  { username: "fixture", password: "" },
]) test(`desktop ${kind} preserves SOCKS credentials ${JSON.stringify(credentials)}`, async () => {
  const ca = createCertificateAuthority({ commonName: "socks-credentials-fixture", validityDays: 1 });
  const leaf = issueServerLeaf(ca, "socks-credentials-fixture", ["chatgpt.com"]);
  const origin = await listenFixture(createHttps({ cert: leaf.certPem, key: leaf.keyPem }, (_req, res) => {
    const body = "authenticated-fixture"; res.setHeader("Content-Length", Buffer.byteLength(body)); res.end(body);
  }));
  const proxy = await forwardProxy("socks5", origin.port, leaf, credentials);
  let socket: Awaited<ReturnType<typeof dialDesktopUpstream>> | undefined;
  try {
    socket = await dialDesktopUpstream({ proxy: proxy.url.replace(/^socks5:/, `${kind}:`), ca: ca.certPem });
    assert.equal(socket.authorized, true);
    assert.equal(await fixtureRequest(socket, "/credentials"), "authenticated-fixture");
    assert.deepEqual(proxy.seen, [{ authority: "chatgpt.com:443", auth: `${credentials.username}:${credentials.password}` }]);
  } finally { socket?.destroy(); await proxy.close(); await origin.close(); }
}, 10000);

test("desktop consumer authenticates to an owned ingress, refreshes only future connections, and closes on shutdown", async () => {
  const ca = createCertificateAuthority({ commonName: "desktop-session-fixture", validityDays: 1 });
  const leaf = issueServerLeaf(ca, "desktop-session-fixture", ["chatgpt.com"]);
  const requests: { origin: string; path: string | undefined; socket: Socket; cookie: string | undefined; proxyAuth: unknown }[] = [];
  let handshakes = 0;
  const createOrigin = (name: string) => {
    const server = createHttps({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
      requests.push({ origin: name, path: req.url, socket: req.socket, cookie: req.headers.cookie, proxyAuth: req.headers["proxy-authorization"] });
      const body = `${name}:${req.url}`; res.setHeader("Content-Length", Buffer.byteLength(body)); res.end(body);
    });
    server.on("secureConnection", () => { handshakes++; });
    return listenFixture(server);
  };
  const firstOrigin = await createOrigin("first"), secondOrigin = await createOrigin("second");
  const firstProxy = await forwardProxy("http", firstOrigin.port, leaf), secondProxy = await forwardProxy("http", secondOrigin.port, leaf);
  const route = (id: string, port: number) => ({ id, kind: "http" as const, host: "127.0.0.1", port, username: "fixture", password: "secret" });
  const owner = {}, username = "session", password = "synthetic-desktop-consumer-capability";
  const authorization = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  const manager = createOwnedIngressManager({ owner, candidates: [route("first", firstProxy.port)],
    allowTarget: authority => authority === "chatgpt.com:443",
    ingress: { sessionMs: 30000, totalMs: 30000, idleMs: 10000, establishMs: 2000 },
    manager: { sessionMs: 30000, startupMs: 2000, shutdownMs: 2000 } });
  const sockets: Awaited<ReturnType<typeof dialDesktopUpstream>>[] = [];
  try {
    const lease = await manager.start(owner, { authorized: true, authorization });
    assert.equal(lease.host, "127.0.0.1");
    const proxy = `http://${username}:${password}@${lease.host}:${lease.port}`;
    const wrongCapability = new URL(proxy); wrongCapability.password = "wrong-fixture-capability";
    await assert.rejects(dialDesktopUpstream({ proxy: wrongCapability.href, ca: ca.certPem, timeoutMs: 1000 }),
      { message: "desktop_upstream_connection_failed" });
    assert.equal(firstProxy.seen.length, 0); assert.equal(secondProxy.seen.length, 0);
    assert.equal(handshakes, 0); assert.equal(requests.length, 0);

    // Do not override the production target: only the upstream fixture proxy redirects it to loopback.
    const first = await dialDesktopUpstream({ proxy, ca: ca.certPem }); sockets.push(first);
    assert.equal(first.authorized, true);
    assert.equal(await fixtureRequest(first, "/before-refresh"), "first:/before-refresh");
    assert.equal(manager.updateRoutes(owner, manager.routeVersion(), [route("second", secondProxy.port)]), 1);
    assert.equal(await manager.start(owner, { authorized: true, authorization }), lease);
    assert.equal(await fixtureRequest(first, "/after-refresh"), "first:/after-refresh");

    const second = await dialDesktopUpstream({ proxy, ca: ca.certPem }); sockets.push(second);
    assert.equal(second.authorized, true);
    assert.equal(await fixtureRequest(second, "/next-connection"), "second:/next-connection");
    assert.deepEqual(requests.map(({ origin, path }) => ({ origin, path })), [
      { origin: "first", path: "/before-refresh" }, { origin: "first", path: "/after-refresh" },
      { origin: "second", path: "/next-connection" },
    ]);
    assert.equal(requests[0]!.socket, requests[1]!.socket);
    assert.notEqual(requests[0]!.socket, requests[2]!.socket);
    for (const request of requests) { assert.equal(request.cookie, "fixture=session"); assert.equal(request.proxyAuth, undefined); }
    const upstreamConnect = [{ authority: "chatgpt.com:443", auth: "Basic " + Buffer.from("fixture:secret").toString("base64") }];
    assert.deepEqual(firstProxy.seen, upstreamConnect); assert.deepEqual(secondProxy.seen, upstreamConnect);
    assert.equal(handshakes, 2); assert.equal(first.destroyed, false); assert.equal(second.destroyed, false);

    await Promise.all([socketClosed(first), socketClosed(second), manager.shutdown(owner)]);
    assert.equal(first.destroyed, true); assert.equal(second.destroyed, true);
    assert.deepEqual(manager.status(), { generation: null, state: "stopped", draining: true, poisoned: false });
    await assert.rejects(dialDesktopUpstream({ proxy, ca: ca.certPem, timeoutMs: 1000 }),
      { message: "desktop_upstream_connection_failed" });
    assert.throws(() => manager.start(owner, { authorized: true, authorization }), /Manager unavailable/);
    assert.equal(requests.length, 3); assert.equal(handshakes, 2);
    assert.deepEqual(firstProxy.seen, upstreamConnect); assert.deepEqual(secondProxy.seen, upstreamConnect);
  } finally {
    for (const socket of sockets) socket.destroy();
    await manager.shutdown(owner); await firstProxy.close(); await secondProxy.close();
    await firstOrigin.close(); await secondOrigin.close();
  }
}, 15000);
