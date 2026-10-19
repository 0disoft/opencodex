import { afterEach, expect, spyOn, test } from 'bun:test';
import WebSocket, { WebSocketServer } from 'desktop-ws';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttps } from 'node:https';
import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { runInNewContext } from 'node:vm';
import { createCertificateAuthority, issueServerLeaf } from '../../src/claude/intercept/local-ca';
import { createDesktopCompatibilityRuntime, type DesktopRuntimeIo } from '../../src/codex/desktop-compatibility/runtime';
import type { DesktopConnectionIdentity } from '../../src/codex/desktop-compatibility/connection-store';
import { resetOptionalShutdownHooksForTests } from '../../src/lib/optional-shutdown-hooks';
import * as proxyRoute from '../../src/lib/desktop-proxy-route';
import { listenFixture } from '../helpers/desktop-egress-fixture';

const account = { id: 'runtime-broker-account', userId: 'runtime-broker-user', plan: 'pro', structure: 'personal' } as const;
const usage = { account_id: account.id, user_id: account.userId, plan_type: account.plan,
  rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: 123456 } },
  spend_control: { reached: false }, credits: { has_credits: false, unlimited: false } };
const broker = '/backend-api/pages/realtime-broker/u123/ws';
const wire = () => JSON.stringify([{ type: 'message', topic_id: 'codex-work-usage-push-v1',
  payload: { type: 'usage.snapshot', payload: { version: 1, stream_id: 'runtime-broker', sequence: 1, generated_at_ms: 1000, usage } } }]);
const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); resetOptionalShutdownHooksForTests(); });

function fixture() {
  // Exact existing authority policy: the DNS subtree permits the WS subdomain.
  const ca = createCertificateAuthority({ commonName: 'runtime-ws-fixture', validityDays: 1,
    permittedDnsNames: ['chatgpt.com'], excludeAllIpAddresses: true, serverAuthOnly: true });
  const certificate = new X509Certificate(ca.certPem);
  let connection: DesktopConnectionIdentity | null = null, httpCalls = 0, authorityLoads = 0;
  const io: DesktopRuntimeIo = { platform: 'win32', testOnly: true,
    identity: { readCurrentIdentity: async () => account, verifyFreshIdentity: async () => account },
    buildSupported: () => true, routingSupported: () => true,
    connectionStore: { read: () => connection, publish: async value => (connection ??= value) },
    loadAuthority: async () => (++authorityLoads, { authority: ca, commonName: 'runtime-ws-fixture', reused: true,
      fingerprint: certificate.fingerprint256.replaceAll(':', ''), expiresAt: Date.parse(certificate.validTo), renewalDue: false }),
    trust: async () => 'trusted', upstreamFetch: (async () => { httpCalls++; return Response.json(usage); }) as typeof fetch };
  const runtime = createDesktopCompatibilityRuntime(io); stops.push(() => runtime.stop());
  return { io, runtime, ca, certificate, httpCalls: () => httpCalls, authorityLoads: () => authorityLoads };
}
async function pacInfo(f: ReturnType<typeof fixture>) {
  const text = await fetch(f.runtime.getPacUrl()!).then(response => response.text());
  return { text, port: Number(/PROXY 127\.0\.0\.1:(\d+)/.exec(text)![1]) };
}
async function event(source: Parameters<typeof once>[0], name: string) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000);
  try { return await once(source, name, { signal: abort.signal }); } finally { clearTimeout(timer); }
}
async function connectTunnel(port: number, authority: string): Promise<{ status: number; socket: Socket }> {
  const socket = tcpConnect({ host: '127.0.0.1', port });
  return new Promise((resolve, reject) => {
    let held = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(new Error('CONNECT fixture timeout')));
    socket.once('error', reject);
    const data = (chunk: Buffer) => {
      held = Buffer.concat([held, chunk]); const end = held.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', data); socket.setTimeout(0);
      if (held.length > end + 4) socket.unshift(held.subarray(end + 4));
      resolve({ status: Number(/^HTTP\/1\.[01] (\d+)/.exec(held.toString('latin1'))?.[1]), socket });
    };
    socket.on('data', data);
    socket.once('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  });
}
async function secureTunnel(f: ReturnType<typeof fixture>, port: number, host: string): Promise<TLSSocket> {
  const tunnel = await connectTunnel(port, `${host}:443`);
  if (tunnel.status !== 200) { tunnel.socket.destroy(); throw new Error('CONNECT refused'); }
  const socket = tlsConnect({ socket: tunnel.socket, servername: host, ca: f.ca.certPem, rejectUnauthorized: true });
  try { await event(socket, 'secureConnect'); return socket; } catch (error) { socket.destroy(); throw error; }
}

test('runtime PAC selects exactly HTTPS/WSS and the two matching hosts on port 443 until its safety deadline', async () => {
  const f = fixture(); await f.runtime.start(); const pac = await pacInfo(f);
  let now = Date.now();
  const select = runInNewContext(pac.text + '; FindProxyForURL', { Date: { now: () => now } }) as (url: string, host: string) => string;
  for (const [url, host] of [['https://chatgpt.com/path', 'chatgpt.com'], ['https://chatgpt.com:443/path', 'chatgpt.com'],
    ['wss://ws.chatgpt.com' + broker, 'ws.chatgpt.com'], ['wss://chatgpt.com/path', 'chatgpt.com'],
    ['https://ws.chatgpt.com:443/path', 'ws.chatgpt.com'], ['WSS://WS.CHATGPT.COM:443/path', 'WS.CHATGPT.COM']]) {
    expect(select(url!, host!)).toBe(`PROXY 127.0.0.1:${pac.port}; DIRECT`);
  }
  for (const [url, host] of [['http://chatgpt.com/path', 'chatgpt.com'], ['ws://ws.chatgpt.com/path', 'ws.chatgpt.com'],
    ['https://chatgpt.com:444/path', 'chatgpt.com'], ['wss://ws.chatgpt.com:80/path', 'ws.chatgpt.com'],
    ['https://other.chatgpt.com/path', 'other.chatgpt.com'], ['https://chatgpt.com.evil/path', 'chatgpt.com.evil'],
    ['https://chatgpt.com@evil/path', 'chatgpt.com'], ['https://ws.chatgpt.com/path', 'chatgpt.com']]) {
    expect(select(url!, host!)).toBe('DIRECT');
  }
  now = f.runtime.status().safetyDeadline!;
  expect(select('wss://ws.chatgpt.com' + broker, 'ws.chatgpt.com')).toBe('DIRECT');
});

test('runtime CONNECT and TLS retain the existing constrained CA while closing every other host and port', async () => {
  const f = fixture(), fingerprint = f.certificate.fingerprint256;
  await f.runtime.start(); const pac = await pacInfo(f);
  for (const host of ['chatgpt.com', 'ws.chatgpt.com']) {
    const socket = await secureTunnel(f, pac.port, host);
    try {
      expect(socket.authorized).toBe(true);
      const leaf = new X509Certificate(socket.getPeerCertificate().raw);
      expect(leaf.checkHost('chatgpt.com')).toBe('chatgpt.com');
      expect(leaf.checkHost('ws.chatgpt.com')).toBe('ws.chatgpt.com');
      expect(leaf.verify(f.ca.publicKey)).toBe(true);
    } finally { socket.destroy(); }
  }
  for (const authority of ['chatgpt.com:80', 'ws.chatgpt.com:444', 'other.chatgpt.com:443', 'chatgpt.com.evil:443', '127.0.0.1:443']) {
    const tunnel = await connectTunnel(pac.port, authority);
    try { expect(tunnel.status).toBe(403); } finally { tunnel.socket.destroy(); }
  }
  expect(new X509Certificate(f.ca.certPem).fingerprint256).toBe(fingerprint);
  const response = await fetch('https://ws.chatgpt.com/backend-api/wham/usage', {
    proxy: `http://127.0.0.1:${pac.port}`, tls: { ca: f.ca.certPem },
  });
  expect(response.status).toBe(421); await response.arrayBuffer(); expect(f.httpCalls()).toBe(0);
});

test('runtime wires broker observations and session correction through CONNECT/TLS without claiming native UI recovery', async () => {
  const f = fixture(), leaf = issueServerLeaf(f.ca, 'runtime-ws-fixture', ['chatgpt.com', 'ws.chatgpt.com']);
  const origin = createHttps({ cert: leaf.certPem, key: leaf.keyPem });
  const wss = new WebSocketServer({ server: origin, perMessageDeflate: false });
  const peers: WebSocket[] = [], clients: WebSocket[] = [];
  wss.on('connection', peer => { peers.push(peer); peer.on('error', () => {}); peer.on('message', () => peer.send(wire())); });
  const upstream = await listenFixture(origin);
  f.io.testOnlyWebsocketPeer = { host: '127.0.0.1', port: upstream.port, ca: f.ca.certPem };
  try {
    await f.runtime.start(); const pac = await pacInfo(f);
    const open = async () => {
      const socket = await secureTunnel(f, pac.port, 'ws.chatgpt.com');
      const ws = new WebSocket('wss://ws.chatgpt.com' + broker, { createConnection: () => socket, perMessageDeflate: false });
      clients.push(ws); ws.on('error', () => {}); await event(ws, 'open'); return ws;
    };
    const read = async (ws: WebSocket) => { const next = event(ws, 'message'); ws.send('snapshot');
      return JSON.parse(Buffer.from((await next)[0]).toString())[0].payload.payload.usage; };
    const original = await open(); expect(await read(original)).toEqual(usage);
    expect(f.runtime.status().usage?.observation.validatedActiveStreams).toBe(1);
    const originalClosed = event(original, 'close');
    expect((await f.runtime.apply(true, 'runtime-session')).accepted).toBe(true); await originalClosed;
    const active = await open();
    expect(await read(active)).toEqual({ ...usage, rate_limit: { ...usage.rate_limit, allowed: true, limit_reached: false } });
    expect(f.runtime.status().usage).toMatchObject({ activationLifetime: 'runtime-session', outputs: 1,
      appCacheConfirmed: false, observation: { sourceProcessVerified: false, composerRecoveryVerified: false } });
    const activeClosed = event(active, 'close'); await f.runtime.stop(); await activeClosed;
    expect(active.readyState).toBe(WebSocket.CLOSED); expect(f.runtime.status().phase).toBe('off');
  } finally {
    for (const ws of clients) ws.terminate(); await f.runtime.stop();
    for (const ws of peers) ws.terminate(); wss.close(); await upstream.close();
  }
}, 15000);

test('isolated websocket peers require every existing sandbox identity, CA and routing seam', async () => {
  const f = fixture(), peer = { host: '127.0.0.1', port: 1, ca: f.ca.certPem };
  for (const key of ['testOnly', 'identity', 'loadAuthority', 'trust', 'buildSupported', 'connectionStore', 'routingSupported'] as const) {
    const runtime = createDesktopCompatibilityRuntime({ ...f.io, testOnlyWebsocketPeer: peer, [key]: undefined });
    await expect(runtime.start()).rejects.toThrow('test_environment'); expect(runtime.status().phase).toBe('off');
  }
});

test('startup preflights both fixed egress hosts before loading a certificate or starting listeners', async () => {
  const f = fixture(), hosts: string[] = [];
  const route = spyOn(proxyRoute, 'desktopProxyFor').mockImplementation(url => {
    hosts.push(url.hostname); if (url.hostname === 'ws.chatgpt.com') throw new Error('fixture invalid route'); return false;
  });
  try {
    await expect(f.runtime.start()).rejects.toThrow('egress_proxy_invalid');
    expect(hosts).toEqual(['chatgpt.com', 'ws.chatgpt.com']);
    expect(f.authorityLoads()).toBe(0); expect(f.runtime.getPacUrl()).toBeNull(); expect(f.runtime.status().phase).toBe('off');
  } finally { route.mockRestore(); }
});
