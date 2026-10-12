# Independent A audit (GOAT delegate_task, codex / gpt-6.1-sol, reasoningEffort high)

Builder: Claude (anthropic/claude-opus-5-5). Reviewer: GPT-6.1-Sol, a different model family.
Each round received the original brief, the prior findings and the builder's response.
Reviewer probes live in the reviewer's scratch directories (/tmp/ocx6990-review*), outside
the repository.

| Round | Verdict | Findings | Builder change |
| --- | --- | --- | --- |
| r1 | FAIL | 2 blocker, 4 major, 2 minor: cleanup unlinked generations other connections still read; settled handle closed before a waiting query resumed; queued manual rebuild survived close; cached known health survived a rebuild start; overlapping tails regressed source size; `layout.json` crossed the 2000-line ratchet; no proxied request in the responsiveness test; translated deletion instructions | Probe-gated reclamation; `withRequestHistoryIndex()` revalidates the handle in the reading turn (analytics moved onto it); lifetime token; epoch at rebuild start and close; monotonic source meta; registrations on an existing line; local SSE upstream + `/v1/chat/completions`; tr/fr/zh-tw and API bullets in all locales |
| r2 | FAIL | 7 of 8 resolved; opening race (connection opened but unused is invisible to the probe); reclamation checkpointed a 540 MB dirty WAL in one statement (607 ms) | Post-open existence check restarts the refresh; serving flights skip files whose WAL exceeds 8 MiB, manual rebuild reclaims them |
| r3 | FAIL | both resolved (607 ms -> 7 ms); new: reclaiming every superseded generation in one step (96 files -> 1.73 s) | Reclamation leaves the refresh: a queue reclaims one file per timer turn after publication |
| r4 | FAIL | resolved (96 turns, max gap 30 ms; cancellation/home switch/CLI exit PASS); new: 500 large accepted records formed one ~460 MB transaction (516 ms) | Batches also commit at 4 MiB of source bytes |
| r5 | FAIL | resolved (max transaction 9 ms, gap 35 ms); new: closing the outgoing generation's last connection checkpointed a WAL an external reader had pinned (940 MB, 620 ms) | A superseded handle whose WAL exceeds the serving bound is parked instead of closed; teardown closes it |
| r6 | PASS | resolved (close 0.05 ms, max gap 3 ms); no new merge blockers; residual accepted as documented risk (below); nit: blank line at EOF | EOF fixed |

## Design amendments after the audit

- D1: a batch commits at 500 rows or 4 MiB of source bytes, whichever comes first.
- D4: superseded generations and the legacy single-file index are reclaimed by a background
  queue, one file per timer turn, only when no initialized connection has them open
  (`PRAGMA journal_mode = DELETE` returns BUSY otherwise) and only when the `-wal` is at most
  8 MiB on a serving flight. A connection opened in the window before its first statement
  detects the reclaim and restarts the refresh.
- D9: async readers use `withRequestHistoryIndex()`; a read whose generation was replaced
  between settling and resuming retries on the next one.
- D10: the health-cache epoch also advances at rebuild start and on close.
- D12: retiring the outgoing generation parks its handle when its `-wal` exceeds the flight's
  bound; parked handles take no commits and close at `closeRequestHistoryIndex()`.

## Residual risk accepted by the reviewer

SQLite checkpoints are single statements. If a process outside the proxy holds a long read
transaction on the live generation while large rows are ingested, the WAL grows past the
auto-checkpoint size; after that reader lets go, the next commit's passive checkpoint (or a
teardown close, e.g. ledger retention) is proportional to the backlog. The reviewer measured
650 ms on this change and 834 ms on origin/dev for the same scenario. The 25 ms / 50 ms
budgets are cooperative targets: they bound the indexer's own steps, not a single SQLite
statement. Removing this case entirely needs SQLite writes on a worker thread.

