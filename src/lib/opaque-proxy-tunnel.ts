/**
 * Explicit authorized opaque proxy tunnel. The desktop upstream dialer consumes
 * a single selected route while retaining its own fixed-target TLS contract.
 * Shares OpenCodex's MIT SOCKS handshake; the caller owns all post-establishment
 * cancellation and socket cleanup. Never replay or implicitly retry directly.
 */
import net, { type Socket } from 'node:net';
import tls from 'node:tls';
import { socks5Handshake, socks5Credentials, Socks5HandshakeError } from './socks5-handshake';

interface RouteEndpoint { id: string; host: string; port: number }
type RouteCredentials = { username?: undefined; password?: undefined } | { username: string; password: string };
type PlainProxy = { kind?: 'http'; proxyCa?: never; proxyServername?: never };
type SecureProxy = { kind: 'https'; proxyCa?: string | Buffer; proxyServername?: string };
type SocksProxy = { kind: 'socks5' | 'socks5h'; proxyCa?: never; proxyServername?: never };
export type OpaqueProxyRoute = RouteEndpoint & RouteCredentials & (PlainProxy | SecureProxy | SocksProxy);
export interface OpaqueTunnelOptions {
  /** Rechecked before each physical attempt and each handshake write. No implicit target permission. */
  allowTarget: (authority: string) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxHeaderBytes?: number;
}
interface AttemptOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxHeaderBytes: number;
  authorize: () => void;
}
export class TunnelError extends Error {
  override readonly name = 'TunnelError';
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(code: string, message: string, { retryable = false, status }: { retryable?: boolean; status?: number } = {}) {
    super(message); this.code = code; this.retryable = retryable; this.status = status;
  }
}
const aborted = () => new TunnelError('ABORTED', 'Tunnel establishment cancelled');

/** Synchronous permission only. Invalid async policies remain denied and observed. */
export function acceptsTargetPolicy(policy: ((authority: string) => unknown) | undefined, authority: string): boolean {
  try {
    const decision: unknown = typeof policy === 'function' ? policy(authority) : false;
    // Never await an async policy to grant access. Observe rejected misuse so
    // private policy context cannot escape through an unhandled rejection.
    if (decision && (typeof decision === 'object' || typeof decision === 'function')) {
      void Promise.resolve(decision).catch(() => {});
    }
    return decision === true;
  } catch { return false; }
}

export function validateAuthority(authority: string): string {
  if (typeof authority !== 'string' || !/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+):[0-9]+$/.test(authority)) {
    throw new TunnelError('TARGET', 'An explicit host:port authority is required');
  }
  const port = Number(authority.slice(authority.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TunnelError('TARGET', 'Invalid target port');
  return authority;
}

function validateOptions(candidates: readonly OpaqueProxyRoute[], timeoutMs: number, maxHeaderBytes: number, totalTimeoutMs = 10000): void {
  if (!Array.isArray(candidates) || !candidates.length) throw new TunnelError('CONFIG', 'Explicit proxy candidates are required');
  const ids = new Set();
  for (const p of candidates) {
    if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.host !== 'string' || !p.host || /[\s/@]/.test(p.host)
      || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535
      || !['http', 'https', 'socks5', 'socks5h'].includes(p.kind ?? 'http')) throw new TunnelError('CONFIG', 'Invalid proxy candidate');
    if ((p.username === undefined) !== (p.password === undefined)
      || (p.username !== undefined && (typeof p.username !== 'string' || typeof p.password !== 'string'
        || (!p.kind?.startsWith('socks') && p.username.includes(':')) || Buffer.byteLength(p.username + p.password) > 4096))) throw new TunnelError('CONFIG', 'Invalid proxy credentials');
    if ((p.kind ?? 'http').startsWith('socks') && p.username !== undefined
      && (Buffer.byteLength(p.username) > 255 || Buffer.byteLength(p.password) > 255)) throw new TunnelError('CONFIG', 'SOCKS credentials must each fit in 255 UTF-8 bytes');
    if ((p.proxyCa !== undefined || p.proxyServername !== undefined) && p.kind !== 'https') throw new TunnelError('CONFIG', 'Proxy TLS settings require HTTPS proxy');
    if (p.proxyCa !== undefined && typeof p.proxyCa !== 'string' && !Buffer.isBuffer(p.proxyCa)) throw new TunnelError('CONFIG', 'Invalid proxy CA');
    if (p.proxyServername !== undefined && (typeof p.proxyServername !== 'string' || !p.proxyServername || /[\s/@\x00]/.test(p.proxyServername))) throw new TunnelError('CONFIG', 'Invalid proxy TLS server name');
    ids.add(p.id);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 120000
    || !Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 64 || maxHeaderBytes > 65536) {
    throw new TunnelError('CONFIG', 'Invalid deadline or header limit');
  }
}

function connectOne(authority: string, proxy: OpaqueProxyRoute, { signal, timeoutMs, maxHeaderBytes, authorize }: AttemptOptions): Promise<Socket> {
  if (proxy.kind === 'socks5' || proxy.kind === 'socks5h') return connectSocks(authority, proxy, { signal, timeoutMs, maxHeaderBytes, authorize });
  return new Promise<Socket>((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    const secure = proxy.kind === 'https';
    const identity = proxy.proxyServername ?? proxy.host;
    const tlsOptions: tls.ConnectionOptions & { allowHalfOpen: boolean } = {
      host: proxy.host, port: proxy.port, allowHalfOpen: true,
      servername: net.isIP(identity) ? undefined : identity, ca: proxy.proxyCa,
      checkServerIdentity: (_name, cert) => tls.checkServerIdentity(identity, cert),
      rejectUnauthorized: true, ALPNProtocols: ['http/1.1'],
    };
    const socket = secure
      ? tls.connect(tlsOptions)
      : net.createConnection({ host: proxy.host, port: proxy.port, allowHalfOpen: true });
    // Keep a defensive observer across the promise-to-owner handoff. Errors still
    // settle the establishment promise or are handled by the relay after handoff.
    socket.on('error', () => {});
    let pending: Buffer = Buffer.alloc(0); let settled = false, tlsReady = !secure;
    const connectedEvent = secure ? 'secureConnect' : 'connect';
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      socket.removeListener(connectedEvent, onConnect); socket.removeListener('data', onData);
      socket.removeListener('error', onError); socket.removeListener('end', onEnd); socket.removeListener('close', onClose);
    };
    const fail = (error: Error) => {
      if (settled) return; settled = true; cleanup(); socket.destroy(); reject(error);
    };
    const onAbort = () => fail(aborted());
    // Partial responses can contain a refusal that has not finished arriving.
    // Fail closed once any proxy response bytes exist, even on transport failure.
    const establishmentFailure = (code: string, message: string) => fail(new TunnelError(code, message, { retryable: pending.length === 0 && tlsReady }));
    const onError = (error: NodeJS.ErrnoException) => {
      if (secure && !tlsReady) {
        const retryable = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code ?? '');
        fail(new TunnelError('PROXY_TLS', 'HTTPS proxy establishment failed', { retryable }));
      } else establishmentFailure('TRANSPORT', 'HTTP proxy connection failed');
    };
    const onEnd = () => establishmentFailure('EARLY_CLOSE', 'HTTP proxy closed before establishing the tunnel');
    const onClose = onEnd;
    const onConnect = () => {
      try { authorize(); } catch (error) { fail(error instanceof Error ? error : new TunnelError('TARGET', 'Target authorization failed')); return; }
      tlsReady = true;
      const auth = proxy.username === undefined ? '' : `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`;
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
    };
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const lineEnd = pending.indexOf('\r\n');
      if (lineEnd >= 0) {
        const firstLine = pending.subarray(0, lineEnd).toString('latin1');
        const firstStatus = /^HTTP\/1\.[01] ([0-9]{3})(?: [\t\x20-\x7e\x80-\xff]*)?$/.exec(firstLine);
        if (!firstStatus) return fail(new TunnelError('PROTOCOL', 'Invalid HTTP proxy status line'));
        const status = Number(firstStatus[1]);
        if (status < 200 || status >= 300) return fail(new TunnelError('REFUSED', 'HTTP proxy refused CONNECT', { status }));
      }
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) {
        if (pending.length > maxHeaderBytes) fail(new TunnelError('PROTOCOL', 'HTTP proxy response headers exceed limit'));
        return;
      }
      if (end + 4 > maxHeaderBytes) return fail(new TunnelError('PROTOCOL', 'HTTP proxy response headers exceed limit'));
      const lines = pending.subarray(0, end).toString('latin1').split('\r\n');
      const statusLine = lines[0];
      const match = /^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?$/.exec(statusLine);
      if (!match) return fail(new TunnelError('PROTOCOL', 'Invalid HTTP proxy status line'));
      const status = Number(match[1]);
      if (lines.slice(1).some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e\x80-\xff]*$/.test(line))) {
        return fail(new TunnelError('PROTOCOL', 'Invalid HTTP proxy response header'));
      }
      // Every HTTP refusal, including 407 and 403, is terminal: trying another
      // candidate could otherwise silently sidestep authentication or policy.
      if (status < 200 || status >= 300) return fail(new TunnelError('REFUSED', 'HTTP proxy refused CONNECT', { status }));
      settled = true; socket.pause(); cleanup();
      const head = pending.subarray(end + 4);
      if (head.length) socket.unshift(head);
      resolve(socket);
    };
    const timer = setTimeout(() => establishmentFailure('TIMEOUT', 'HTTP proxy establishment deadline exceeded'), timeoutMs);
    socket.once(connectedEvent, onConnect); socket.on('data', onData);
    socket.once('error', onError); socket.once('end', onEnd); socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

// The bounded socket reader owns setup cancellation and preserves queued bytes.
// Framing uses the existing
// MIT socks5-handshake module; neither shared framing nor its DNS policy changes.
async function connectSocks(authority: string, proxy: OpaqueProxyRoute, { signal, timeoutMs, authorize }: AttemptOptions): Promise<Socket> {
  if (signal?.aborted) throw aborted();
  const socket = net.createConnection({ host: proxy.host, port: proxy.port, allowHalfOpen: true });
  socket.on('error', () => {});
  let buffer: Buffer = Buffer.alloc(0), failure: Error | undefined, bytesSeen = 0;
  let waiting: { length: number; resolve: () => void; reject: (error: Error) => void } | undefined;
  const fail = (error: Error) => { if (failure) return; failure = error; const current = waiting; waiting = undefined; current?.reject(error); socket.destroy(); };
  const transportError = (code: string, message: string) => fail(new TunnelError(code, message, { retryable: bytesSeen === 0 }));
  const onData = (chunk: Buffer) => {
    // Consume at most the bytes needed by a bounded handshake read, then pause.
    // A valid CONNECT reply can share a packet with arbitrary early target data;
    // that remainder is not a malformed/oversized handshake and must survive.
    socket.pause();
    bytesSeen += chunk.length;
    buffer = Buffer.concat([buffer, chunk]);
    if (waiting && buffer.length >= waiting.length) { const current = waiting; waiting = undefined; current.resolve(); }
    else if (waiting) socket.resume();
  };
  const onError = () => transportError('TRANSPORT', 'SOCKS proxy connection failed');
  const onClose = () => transportError('EARLY_CLOSE', 'SOCKS proxy closed before tunnel establishment');
  const onAbort = () => fail(aborted());
  const timer = setTimeout(() => transportError('TIMEOUT', 'SOCKS establishment deadline exceeded'), timeoutMs);
  socket.on('data', onData); socket.once('error', onError); socket.once('end', onClose); socket.once('close', onClose);
  socket.pause();
  signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
  const reader = {
    write(bytes: Uint8Array): void { if (failure) throw failure; authorize(); socket.write(bytes); },
    async readExact(length: number): Promise<Buffer> {
      if (failure) throw failure;
      if (!Number.isSafeInteger(length) || length < 0 || length > 1024) throw new TunnelError('PROTOCOL', 'Invalid handshake read size');
      if (buffer.length < length) await new Promise<void>((resolve, reject) => {
        if (waiting) { reject(new TunnelError('PROTOCOL', 'Concurrent handshake read')); return; }
        waiting = { length, resolve, reject };
        socket.resume();
      });
      if (failure) throw failure;
      const result = buffer.subarray(0, length); buffer = buffer.subarray(length); return result;
    },
  };
  try {
    const credentialsUrl = new URL('socks5://fixture.invalid');
    if (proxy.username !== undefined) { credentialsUrl.username = encodeURIComponent(proxy.username); credentialsUrl.password = encodeURIComponent(proxy.password); }
    const colon = authority.lastIndexOf(':');
    const target = { host: authority.slice(0, colon).replace(/^\[|\]$/g, ''), port: Number(authority.slice(colon + 1)) };
    await socks5Handshake(reader, target, socks5Credentials(credentialsUrl), signal);
    if (failure) throw failure;
    if (signal?.aborted || socket.destroyed) throw aborted();
    socket.pause(); if (buffer.length) socket.unshift(buffer); buffer = Buffer.alloc(0);
    return socket;
  } catch (error) {
    socket.destroy();
    if (error instanceof Socks5HandshakeError) throw new TunnelError('SOCKS_REFUSED', 'SOCKS authentication, policy, or protocol refusal');
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    socket.removeListener('data', onData); socket.removeListener('error', onError);
    socket.removeListener('end', onClose); socket.removeListener('close', onClose);
  }
}

/** Establish only. There is no application data, implicit DIRECT, or replay here.
 * HTTP/HTTPS CONNECT and SOCKS5/SOCKS5h yield an opaque raw target tunnel.
 */
export async function dialTunnel(authority: string, candidates: readonly OpaqueProxyRoute[], options: OpaqueTunnelOptions): Promise<{ socket: Socket; routeId: string }> {
  const { signal, timeoutMs = 1000, totalTimeoutMs = 10000, maxHeaderBytes = 8192, allowTarget } = options ?? {};
  const authorize = (): void => {
    if (!acceptsTargetPolicy(allowTarget, authority)) throw new TunnelError('TARGET', 'Target is not authorized');
  };
  validateAuthority(authority); validateOptions(candidates, timeoutMs, maxHeaderBytes, totalTimeoutMs); authorize();
  // Freeze the route decision for this attempt; caller edits affect future dials.
  const selected: OpaqueProxyRoute[] = candidates.map(p => p.kind === 'https' ? { ...p, proxyCa: Buffer.isBuffer(p.proxyCa) ? Buffer.from(p.proxyCa) : p.proxyCa } : { ...p });
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), totalTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let last: TunnelError | undefined;
  try {
  for (const proxy of selected) {
    authorize();
    if (combined.aborted) throw aborted();
    try {
      const socket = await connectOne(authority, proxy, { signal: combined, timeoutMs, maxHeaderBytes, authorize });
      // Permission can change while a proxy reply is in flight. A completed
      // handshake alone never authorizes handing a target socket to the caller.
      try { authorize(); if (combined.aborted) throw aborted(); }
      catch (error) { socket.destroy(); throw error; }
      return { socket, routeId: proxy.id };
    } catch (error) {
      if (combined.aborted) throw aborted();
      if (!(error instanceof TunnelError) || !error.retryable) throw error;
      last = error;
    }
  }
  throw new TunnelError('ALL_FAILED', `All ${selected.length} configured proxies failed (${last?.code ?? 'UNKNOWN'})`);
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) throw new TunnelError('TOTAL_TIMEOUT', 'Overall tunnel establishment deadline exceeded');
    throw error;
  } finally { clearTimeout(timer); }
}
