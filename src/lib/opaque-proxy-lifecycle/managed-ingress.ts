import {createServer} from 'node:net';
import {parseConnectRequest, ConnectRequestError} from './connect-request';
import { timingSafeEqual } from 'node:crypto';
import {Socket, type AddressInfo} from 'node:net';
import {dialTunnel, acceptsTargetPolicy, snapshotProxyRoutes, type OpaqueProxyRoute} from '../opaque-proxy-tunnel';

export interface ManagedIngressOptions {
  authorization: string;
  candidates: readonly OpaqueProxyRoute[];
  allowTarget(authority: string): boolean;
  maxActive?: number; maxQueued?: number; maxClients?: number;
  idleMs?: number; totalMs?: number; sessionMs?: number;
  queueMs?: number; establishMs?: number;
  dial?: typeof dialTunnel;
}
interface ClientRecord {
  client: Socket; controller: AbortController; done: boolean; active: boolean;
  authority?: string; head?: Buffer; upstream?: Socket;
  routes?: readonly OpaqueProxyRoute[];
  totalTimer?: ReturnType<typeof setTimeout>;
  queueTimer?: ReturnType<typeof setTimeout>;
  establishTimer?: ReturnType<typeof setTimeout>;
}

const integer = (x: number, name: string, min = 1) => {
  if (!Number.isSafeInteger(x) || x < min || x > 2 ** 31 - 1) throw new Error(`Invalid ${name}`);
};

/** All limits include unauthenticated clients. The dialer owns establishment only. */
export function createManagedIngress({ authorization, candidates, allowTarget,
  maxActive = 16, maxQueued = 16, maxClients = 64, idleMs = 30000,
  totalMs = 300000, sessionMs = 300000, queueMs = 3000, establishMs = 5000, dial = dialTunnel }: ManagedIngressOptions) {
  if (typeof authorization !== 'string' || authorization.length < 40 || /[\r\n]/.test(authorization)) throw new Error('Private capability required');
  if (typeof allowTarget !== 'function' || !Array.isArray(candidates) || !candidates.length) throw new Error('Explicit routes and policy required');
  for (const [key, val] of Object.entries({maxActive, maxClients, idleMs, totalMs, queueMs, establishMs, sessionMs})) integer(val, key);
  integer(maxQueued, 'maxQueued', 0);
  if (establishMs > 30000) throw new Error('Establishment deadline exceeds transport limit');
  let routes = snapshotProxyRoutes(candidates);
  const secret = Buffer.from(authorization);
  const clients = new Map<Socket, ClientRecord>(), queue: ClientRecord[] = [];
  let active = 0, closing = false;
  let listenPromise: Promise<AddressInfo> | undefined;
  let closePromise: Promise<void> | undefined;
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  // Bun node:http emits connection only after request bytes arrive. A raw net
  // listener is required to own unauthenticated/slowloris sockets from accept.
  const server = createServer({allowHalfOpen: true});
  server.on('error', () => {void api.close();});
  function finish(record: ClientRecord) {
    if (record.done) return;
    record.done = true;
    clearTimeout(record.totalTimer); clearTimeout(record.queueTimer); clearTimeout(record.establishTimer);
    record.controller.abort(); record.upstream?.destroy();
    clients.delete(record.client);
    const i = queue.indexOf(record); if (i !== -1) queue.splice(i, 1);
    if (record.active) { active--; record.active = false; }
    pump();
  }
  function reject(record: ClientRecord, code: string) {
    if (record.done || record.client.destroyed) return;
    const queuedIndex = queue.indexOf(record); if (queuedIndex !== -1) queue.splice(queuedIndex, 1);
    const challenge = code === '407 Proxy Authentication Required' ? 'Proxy-Authenticate: Basic realm="opencodex-session"\r\n' : '';
    record.client.end(`HTTP/1.1 ${code}\r\n${challenge}Connection: close\r\nContent-Length: 0\r\n\r\n`, () => record.client.destroy());
  }
  server.on('connection', client => {
    client.on('error', () => {});
    if (closing || clients.size >= maxClients || client.remoteAddress !== '127.0.0.1') { client.destroy(); return; }
    const record: ClientRecord = {client, controller: new AbortController(), done:false, active:false};
    clients.set(client, record);
    record.totalTimer = setTimeout(() => {client.destroy(); record.upstream?.destroy();}, totalMs);
    client.setTimeout(idleMs, () => client.destroy());
    client.once('close', () => {
      if (!record.upstream || record.upstream.destroyed || !client.readableEnded) finish(record);
      // A graceful downstream EOF may still have bytes queued for upstream.
      // Keep this slot and its absolute deadline until that writable drains.
    });
    readConnect(record);
  });
  function pump() {
    while (!closing && active < maxActive && queue.length) {
      const record = queue.shift();
      if (record) begin(record);
    }
  }
  function begin(record: ClientRecord) {
    if (record.done) return;
    clearTimeout(record.queueTimer); record.active = true; active++;
    record.establishTimer = setTimeout(() => {record.controller.abort(); record.client.destroy();}, establishMs);
    // One dial per accepted connection. No replay after commitment.
    Promise.resolve().then(() => {
      if (record.done || closing || record.controller.signal.aborted) throw new Error('Closed');
      const authority = record.authority;
      if (!authority) throw new Error('Missing accepted target');
      return dial(authority, record.routes ?? [], {signal:record.controller.signal, timeoutMs:establishMs,
        totalTimeoutMs:establishMs, allowTarget: target => target === authority && acceptsTargetPolicy(allowTarget, target)});
    }).then(({socket: upstream}) => {
      clearTimeout(record.establishTimer);
      if (closing || record.done || record.controller.signal.aborted || record.client.destroyed) {upstream.destroy(); return;}
      record.upstream = upstream;
      const client = record.client;
      const destroy = () => {client.destroy(); upstream.destroy();};
      upstream.on('error', destroy); client.once('error', destroy);
      upstream.setTimeout(idleMs, destroy);
      upstream.once('close', () => {
        if (!upstream.readableEnded) client.destroy();
        if (client.destroyed) finish(record);
      });
      client.once('close', () => {if (!client.readableEnded) upstream.destroy();});
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (record.head?.length) client.unshift(record.head);
      client.pipe(upstream); upstream.pipe(client);
    }).catch(() => {clearTimeout(record.establishTimer); reject(record, '502 Bad Gateway');});
  }
  function readConnect(record: ClientRecord) {
    const client = record.client;
    let buffered = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0 && buffered.length <= 8192) return;
      client.pause(); client.removeListener('data', receive);
      if (record.done || closing) {client.destroy(); return;}
      if (end < 0 || end > 8192) {reject(record, '431 Request Header Fields Too Large'); return;}
      let request;
      try {request = parseConnectRequest(buffered.subarray(0, end));}
      catch (error) {reject(record, error instanceof ConnectRequestError ? error.status : '400 Bad Request'); return;}
      const supplied = Buffer.from(request.authorization ?? '');
      if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {reject(record, '407 Proxy Authentication Required'); return;}
      const allowed = acceptsTargetPolicy(allowTarget, request.authority);
      if (!allowed) {reject(record, '403 Forbidden'); return;}
      record.authority = request.authority; record.head = buffered.subarray(end + 4);
      record.routes = routes;
      if (active < maxActive) begin(record);
      else if (queue.length < maxQueued) {
        queue.push(record); record.queueTimer = setTimeout(() => {reject(record, '503 Service Unavailable');}, queueMs);
      } else reject(record, '503 Service Unavailable');
    };
    client.once('end', () => {if (!record.authority) client.destroy();});
    client.on('data', receive);
  }
  const api = {
    server,
    replaceCandidates(candidates: readonly OpaqueProxyRoute[]): void {
      if (closing) throw new Error('Closed');
      routes = snapshotProxyRoutes(candidates);
    },
    stats: () => ({clients:clients.size, active, queued:queue.length}),
    listen(): Promise<AddressInfo> {
      if (closing) return Promise.reject(new Error('Closed'));
      return listenPromise ??= new Promise<AddressInfo>((resolve, reject) => {
        const fail = (error: Error) => {server.removeListener('listening', ready); reject(error);};
        const ready = () => {
          server.removeListener('error', fail);
          const address = server.address();
          if (!address || typeof address === 'string') {reject(new Error('Invalid listening address')); return;}
          resolve(address);
        };
        server.once('error', fail); server.once('listening', ready); sessionTimer = setTimeout(() => {void api.close();}, sessionMs);
        server.listen(0, '127.0.0.1');
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true; clearTimeout(sessionTimer);
      for (const record of clients.values()) {record.controller.abort(); record.client.destroy(); record.upstream?.destroy();}
      closePromise = (async () => {
        if (listenPromise) await listenPromise.catch(() => {});
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      })();
      return closePromise;
    },
  };
  return api;
}
