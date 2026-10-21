# ADR-7462 — decision recorded under "Codex WebSocket upgrade metadata"

- Contract owner: [transports/codex-ws-metadata.md](../transports/codex-ws-metadata.md)

## Decision record

- Purpose and intent: Preserve an upstream reasoning-accounting signal lost when a native WS upgrade becomes an HTTP/SSE response.
- Existing implementation and constraints: Frame metadata is projected before the first Responses event, but the session discards upgrade response headers. The client-facing WebSocket upgrade belongs to an earlier lifecycle.
- Alternatives considered: Infer a flag from model/config/history; replay every safe upgrade header; replace the transport; capture only the actual connection-level reasoning signal.
- Choice: Observe Bun's optional native handshake event, validate the 101/raw-header shape within the existing metadata byte/count/value ceilings, and retain only the allowlisted reasoning header on the socket. Seed each exchange's existing metadata owner before sending.
- Reason: An absent signal cannot be reconstructed truthfully. Replaying request IDs or quota snapshots on a reused connection would misattribute later turns. The existing owner already defines frame precedence, header commit and filtering.
- Consequences: Actual true/false values survive WS-to-SSE conversion; current frame metadata takes precedence and late frames stay in-band. Snapshots are private and cleared at disposal. Missing extensions or malformed observations preserve previous behavior without replay or synthesized usage. This does not establish the cause of an early-compaction incident or fix downstream native-client accounting.
