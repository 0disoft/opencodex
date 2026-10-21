# Codex WebSocket upgrade metadata

`src/server/responses/codex-ws-session.ts` owns the captured connection header.
`src/server/responses/codex-ws-metadata.ts` validates the optional handshake
observation; `src/server/responses/codex-ws-exchange.ts` seeds the exchange owner.

The canonical WS-to-HTTP/SSE lane captures an actual 101 `x-reasoning-included`
header through Bun's optional native `handshake` event before dispatch. The socket
retains only that bounded connection signal; request IDs and quota snapshots are
not replayed across exchanges. Each exchange seeds its existing metadata owner
with a private copy, so current prelude metadata overrides the upgrade value and
late frames cannot rewrite committed HTTP headers. Missing, malformed, ambiguous
or over-budget upgrade observations remain absent. No model/config/input heuristic
creates a flag. Disposal clears the captured value. Client-facing WebSocket upgrade
headers are already committed on a separate lifecycle and gain no retrofit.

> Decision record: [ADR-7462](../decisions/ADR-7462-ws-upgrade-reasoning-header.md)

The raw header list accepts at most 128 pairs and 32 KiB, and a reasoning
value at most 4 KiB, using the existing metadata ceilings. Duplicate reasoning
headers, non-string pairs and invalid control characters omit the signal.
All other upgrade headers are discarded, including otherwise-safe quota and
request identifiers whose freshness belongs to a request.

`tests/responses/ws-upgrade-reasoning-header.test.ts` exercises real loopback
upgrades, absent/false controls, frame precedence, committed headers, usage
preservation, retained sockets, private snapshots, disposal and malformed bounds.
The [ordinary WS/SSE contract](responses-wire-shapes.md#passthrough-sse-stream-shapes-314)
owns fallback, frame/queue limits and failure delivery.
