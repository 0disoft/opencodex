# Architect consultation (formal P)

- Proposal: GOAT delegated task `6990-architect-proposal-r1` (codex / gpt-6.1-sol, reasoningEffort high), decisions D1–D12 (architect numbering, prefixed A below).

| Architect decision | Disposition | Reason |
| --- | --- | --- |
| A-D1 resumable ingest, 64 KiB reads, rows+bytes transaction cap, 10 ms slice, setImmediate | Amended | Same 64 KiB generator. Slice 25 ms. Yield with `setTimeout(0)`: the architect's out-of-process probe served HTTP with both primitives (setImmediate 149 vs setTimeout 299 probes, max 2.5 ms each); main's in-process probe starved under setImmediate (p50 50 ms) and not under setTimeout(0) (p50 0.1 ms). At 25 ms slices the ~1 ms timer clamp costs ~4 %. Repo precedent `src/usage/log.ts:1461`. Batch cap stays rows (500) plus one commit per yield. |
| A-D2 bounded sync entry, one background flight, no repeated budget | Accepted | Plan D3; volume rule (pending ingest <= 1 MiB finishes synchronously) keeps small tails deterministic. |
| A-D3 generation files + atomic manifest | Rejected in r1, adopted after reflection (generations without a manifest) | See reflection gap 1. Readers select the newest `g…` name, so no manifest file is needed. |
| A-D4 coordinator lock DB, busy_timeout defeats budget | Partly accepted | No coordinator DB: generations remove the publication race, and in-transaction counts make concurrent tails safe. busy_timeout 25 ms; SQLITE_BUSY yields and retries, never rebuilds. |
| A-D5 detect replacement, conservative cleanup | Accepted | Directory listing on every refresh and before every tail commit; abandoned builds removed only when the owning pid is dead. |
| A-D6 reader consistency, bounded catch-up, cache binding | Accepted | Ingest stops at the ledger size captured at start; health cache bound to the index epoch (plan D10). |
| A-D7 atomic rows + checkpoint, in-memory counts after COMMIT | Accepted | Plan D1. |
| A-D8 no integrity scan on refresh, classify CORRUPT/NOTADB | Accepted | Plan D6. |
| A-D9 close cancels with captured paths and token | Accepted | Plan D8. |
| A-D10 carry specific reason | Accepted | Plan D7. |
| A-D11 keep test assertions; generation path fixtures | Accepted; path fixtures unchanged | File name unchanged because A-D3 is rejected. |
| A-D12 modular leaf modules, no Lab | Accepted | `ingest.ts` split; boundary test in verifier list. |

## Reflection (round `6990-architect-reflection-r1`): MISALIGNED, gaps resolved in the plan

| Gap | Severity | Resolution |
| --- | --- | --- |
| 1 publication lacks cross-process safety | blocker | Adopted generations (plan D4): build privately, publish under a never-used name, no rename over an open database, no shared side-file names. The first draft's "rebuildable corruption is acceptable" reason is withdrawn. |
| 2 sync budget escapable by byte volume; 100 ms busy timeout | major | Byte exception removed; deadline checked between bounded steps (plan D3). busy_timeout 25 ms with yield-and-retry on BUSY (D1, D6). |
| 3 ledger validity across yields | major | Before every commit and before publication the path must still name the inode being read and the file must not have shrunk; otherwise the refresh restarts (D1). Same-size in-place rewrites of the append-only ledger are not detectable from metadata; retention replaces the ledger by rename and closes the index in-process. |
| 4 cancellation and rejection ownership | major | `generator.return()` cancellation, no yields in `finally`, closed flights never resumed by their timer, rejection handler attached at creation (D2, D8). |
| 5 reopen must not reuse stale ingest state; manual rebuild through the same owner; one generation per read | major | A tail that finds its generation superseded throws stale and restarts from the newest generation (D5); manual rebuild runs a forced flight (D11); queries read rows and meta from the settled flight's handle (D9). |
| 6 health cache contract | minor | Epoch-bound cache (D10); test strict exclusion during busy and recovery after. Documented in docs-site. |
| 7 deterministic failure verifiers | major | Test seam `setRequestHistoryBudgetsForTests({ sliceMs: 0, syncBudgetMs: 0 })` makes every drive advance exactly one step, so cancellation, resume and generation switch are tested at exact step boundaries; HTTP progress asserted during an unfinished rebuild with generous bounds. |

A second reflection round is folded into the independent A audit, which receives the
same gap list.

