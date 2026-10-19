import WebSocket, { WebSocketServer, type RawData } from "desktop-ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import type { DesktopUpstreamHost } from "../../lib/desktop-upstream-tunnel";
import type { UsageRelayController } from "./usage-controller";

export type UsagePushController = Pick<UsageRelayController, "registerPushStream" | "rewritePushMessage">;
// ws's default 100MiB ceiling bounds full-message assembly on this shared broker.
// It is deliberately independent of the controller's 256KiB rewrite/skip ceiling.
export const USAGE_WEBSOCKET_MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
type Registration = ReturnType<UsagePushController["registerPushStream"]>;
const HANDSHAKE = new Set(["connection", "upgrade", "sec-websocket-key", "sec-websocket-accept",
  "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions", "proxy-authorization", "proxy-connection"]);
export const isUsageWebSocketPath = (path: string) => /^\/backend-api\/pages\/realtime-broker\/u[0-9]+\/ws$/.test(path);

function requestHeaders(request: IncomingMessage) {
  const headers: Record<string, string | string[]> = {};
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase(), value = request.rawHeaders[i + 1]!;
    if (HANDSHAKE.has(name)) continue;
    const previous = headers[name];
    headers[name] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return headers;
}
function closePeer(socket: WebSocket, code: number, reason: Buffer) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (code === 1006) socket.terminate();
  else socket.close(code === 1005 ? undefined : code, reason);
}
const bytes = (data: RawData): Buffer => Array.isArray(data) ? Buffer.concat(data)
  : Buffer.isBuffer(data) ? data : Buffer.from(data);

/** Owns one broker connection. Only the controller may verify/bind usage or change text. */
export function relayUsageWebSocket(request: IncomingMessage, client: Duplex, head: Buffer, options: {
  host: DesktopUpstreamHost;
  pathname: string;
  controller?: UsagePushController;
  signal: AbortSignal;
  dial: (signal: AbortSignal) => Promise<TLSSocket>;
}): Promise<void> {
  return new Promise(resolve => {
    let complete!: () => void;
    const completed = new Promise<void>(done => { complete = done; });
    const cancel = new AbortController();
    let upstream: WebSocket | undefined, downstream: WebSocket | undefined, transport: TLSSocket | undefined;
    let response: IncomingMessage | undefined, registration: Registration = null;
    let dialing: Promise<void> | undefined;
    let finished = false, closing = false, rejected = false, policyFailed = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let toClient = Promise.resolve(), toUpstream = Promise.resolve();
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, clientTracking: false, autoPong: false,
      maxPayload: USAGE_WEBSOCKET_MAX_MESSAGE_BYTES, handleProtocols: () => upstream?.protocol || false });
    const finish = () => {
      if (finished) return;
      finished = closing = true; clearTimeout(deadline); registration?.release(); registration = null;
      const closed: Promise<unknown>[] = [client, transport].filter((socket): socket is Duplex => !!socket)
        .filter(socket => !socket.closed).map(socket => new Promise<void>(done => socket.once("close", () => done())));
      for (const ws of [upstream, downstream]) if (ws && ws.readyState !== WebSocket.CLOSED) {
        closed.push(new Promise<void>(done => ws.once("close", () => done())));
      }
      if (dialing) closed.push(dialing);
      options.signal.removeEventListener("abort", finish); cancel.abort();
      upstream?.terminate(); downstream?.terminate(); transport?.destroy(); response?.destroy();
      client.destroy(); wss.close();
      void Promise.all(closed).then(() => { complete(); resolve(); });
    };
    const boundClose = () => { if (!finished) deadline ??= setTimeout(finish, 1000); };
    const reject = (status: number) => {
      if (finished || rejected) return;
      rejected = true;
      if (downstream) { finish(); return; }
      client.end(`HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : "Bad Gateway"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      boundClose();
    };
    const socketError = (error: Error, peer: WebSocket | undefined) => {
      if (finished || rejected) return;
      if ((error as NodeJS.ErrnoException).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" && downstream) {
        closing = true; registration?.release();
        // ws already sent 1009 to the offending source; notify the opposite leg too.
        if (peer) closePeer(peer, 1009, Buffer.from("Message too big")); boundClose();
      } else if (downstream) finish(); else reject(502);
    };
    options.signal.addEventListener("abort", finish, { once: true });
    client.once("error", finish);
    client.once("close", () => { if (!downstream) finish(); });
    if (options.signal.aborted || client.destroyed) { finish(); return; }
    // Validate cheap downstream framing before an authenticated upstream dial.
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket"
      || request.headers["sec-websocket-version"] !== "13"
      || !/^[+/0-9A-Za-z]{22}==$/.test(String(request.headers["sec-websocket-key"] ?? ""))) { reject(400); return; }
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    try {
      upstream = new WebSocket(`wss://${options.host}${request.url}`, protocols, {
        // Node HTTP supports repeated header arrays; ws's declaration narrows these to strings.
        headers: requestHeaders(request) as WebSocket.ClientOptions["headers"],
        perMessageDeflate: false, autoPong: false, maxPayload: USAGE_WEBSOCKET_MAX_MESSAGE_BYTES, followRedirects: false,
        handshakeTimeout: 30000,
        // @types/ws models net.connect's synchronous return, whereas Node HTTP
        // also supports its async (error, connectedSocket) connection callback.
        createConnection: ((_settings: unknown, callback: (error: Error | null, socket?: TLSSocket) => void) => {
          dialing = options.dial(cancel.signal).then(socket => {
            if (finished || closing || cancel.signal.aborted) { socket.destroy(); return; }
            transport = socket;
            callback(null, socket);
          }).catch(() => { if (!finished && !closing) callback(new Error("desktop_upstream_connection_failed")); });
          return undefined!;
        }) as unknown as NonNullable<WebSocket.ClientOptions["createConnection"]>,
      });
    } catch { reject(400); return; }
    upstream.on("error", error => socketError(error, downstream));
    upstream.on("unexpected-response", (_request, incoming) => {
      if (finished) { incoming.destroy(); return; }
      rejected = true; response = incoming;
      const lines = [`HTTP/1.1 ${incoming.statusCode ?? 502} ${incoming.statusMessage ?? ""}`];
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        if (!/^(?:connection|transfer-encoding|proxy-authenticate|proxy-authorization)$/i.test(incoming.rawHeaders[i]!)) {
          lines.push(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}`);
        }
      }
      client.write(lines.join("\r\n") + "\r\nConnection: close\r\n\r\n");
      incoming.once("error", finish); incoming.pipe(client);
    });
    upstream.on("upgrade", incoming => { response = incoming; });
    const enqueue = (source: WebSocket, destination: WebSocket, data: RawData, binary: boolean, rewrite: boolean) => {
      source.pause();
      const forward = async () => {
        if (finished || closing || destination.readyState !== WebSocket.OPEN) return;
        const original = bytes(data);
        let corrected: string | null = null;
        if (rewrite && !binary && !policyFailed && options.controller) {
          try { corrected = await options.controller.rewritePushMessage(original.toString("utf8"), registration); }
          catch {
            // A policy failure makes this connection observe-only: preserve the
            // original bytes and prevent later messages from rebinding refresh.
            policyFailed = true; registration?.exclude();
          }
        }
        if (finished || closing || destination.readyState !== WebSocket.OPEN) return;
        await new Promise<void>((sent, failed) => destination.send(corrected ?? original, { binary }, error => error ? failed(error) : sent()));
      };
      if (rewrite) {
        const current = toClient = toClient.then(forward).catch(finish);
        void current.then(() => { if (toClient === current && !finished && !closing && source.readyState === WebSocket.OPEN) source.resume(); });
      } else {
        const current = toUpstream = toUpstream.then(forward).catch(finish);
        void current.then(() => { if (toUpstream === current && !finished && !closing && source.readyState === WebSocket.OPEN) source.resume(); });
      }
    };
    upstream.on("message", (data, binary) => { if (downstream) enqueue(upstream!, downstream, data, binary, true); });
    const control = (destination: WebSocket | undefined, kind: "ping" | "pong", data: Buffer) => {
      if (finished || closing || destination?.readyState !== WebSocket.OPEN) return;
      destination[kind](data, undefined, error => { if (error) finish(); });
    };
    upstream.on("ping", data => control(downstream, "ping", data));
    upstream.on("pong", data => control(downstream, "pong", data));
    upstream.on("close", (code, reason) => {
      if (finished) return;
      if (!downstream) { if (!rejected) reject(502); return; }
      if (downstream.readyState === WebSocket.CLOSED) { finish(); return; }
      // A final message still awaiting identity verification precedes peer Close.
      void toClient.then(() => { if (!finished) { closePeer(downstream!, code, reason); boundClose(); } });
    });
    upstream.on("open", () => {
      if (finished || rejected || closing) return;
      wss.once("headers", headers => {
        const incoming = response?.rawHeaders ?? [];
        for (let i = 0; i < incoming.length; i += 2) {
          if (!HANDSHAKE.has(incoming[i]!.toLowerCase())) headers.push(`${incoming[i]}: ${incoming[i + 1]}`);
        }
      });
      try {
        wss.handleUpgrade(request, client, head, ws => {
          downstream = ws;
          registration = options.controller?.registerPushStream(options.pathname, async () => {
            if (!finished && !closing) {
              closing = true; registration?.release();
              closePeer(ws, 1012, Buffer.from("usage-refresh"));
              closePeer(upstream!, 1012, Buffer.from("usage-refresh")); boundClose();
            }
            // Controller refresh waits for actual socket cleanup, not a queued close.
            await completed;
          }) ?? null;
          ws.on("message", (data, binary) => enqueue(ws, upstream!, data, binary, false));
          ws.on("ping", data => control(upstream, "ping", data));
          ws.on("pong", data => control(upstream, "pong", data));
          ws.on("error", error => socketError(error, upstream));
          ws.on("close", (code, reason) => {
            if (finished) return;
            closing = true; registration?.release();
            if (upstream!.readyState === WebSocket.CLOSED) finish();
            else { closePeer(upstream!, code, reason); boundClose(); }
          });
        });
      } catch { reject(502); }
    });
  });
}
