# 060 — Windows rebuild lag (hosted windows 6/9, PR #7009)

## Evidence

- Hosted run 38284336713, `server-history-rebuild-responsiveness.test.ts:199`: `{"rebuildMs":4742,"maxLagMs":508,...}`. The earlier run had 545. The 060 change below replaces the 020 R2 hypothesis (the health query), which did not explain it.
- Windows 11 desktop (`desktop-c795oh4`, Bun 1.4.3), with a scratch tracer that is never committed:
  - no directly wrapped synchronous fs call, spawn, or `Database.exec/query` and `Statement` call reached 25 ms during the rebuild. The ingest COMMIT runs through `db.transaction(fn)()`, which that wrapper did not cover; it was timed separately (below). A forced full GC took about 20 ms at a 40 MB heap, and spawning `icacls` took about 4 ms;
  - generator steps took 20–74 ms; each long step contains a 500-row COMMIT, which grows from 10 ms to 20–54 ms;
  - journal mode is the lever (same test, commits of 10 ms or more):

| Private-build journal | Sum of commits >= 10 ms (count) | Max commit | Rebuild |
|---|---:|---:|---:|
| DELETE (current) | 3038 ms / 129 | 60.8 ms | 5170 ms |
| MEMORY | 445 ms / 32 | 31.2 ms | 2400 ms |
| MEMORY + 64 MB cache | 363 ms / 28 | 29.7 ms | 2353 ms |
| DELETE + 64 MB cache | 3099 ms / 132 | 82.5 ms | 5170 ms |

The DELETE journal creates and removes a rollback file on every commit. On Windows that file churn dominates, and slower CI disks and antivirus scanning magnify it. `driveFlight` checks its slice deadline only after a step (`indexer.ts:526`), so a long commit sets the lag floor.

## Changes

The thresholded commit sum drops about 7x; the whole rebuild drops about 2.2x.

R3 — MODIFY `src/routing/history/indexer.ts` (private build, about line 441): `PRAGMA journal_mode = MEMORY` in place of `DELETE`. The private build is disposable: a crash leaves an abandoned `b…sqlite` that readers never select and `removeAbandonedBuilds` deletes best effort (`generations.ts:44`, `:85`). In-process ROLLBACK still works. The build connection still switches to WAL before close and rename (`indexer.ts:462`), unchanged. The cache size stays unchanged (no measured benefit).

R4 — MODIFY `src/routing/history/ingest.ts` (architect Bacon D1–D3):

- `pending` holds `{ values, endOffset, sourceBytes }`. A prefix of `take` rows checkpoints at `pending[take-1].endOffset` when it leaves rows behind. When it drains the queue it checkpoints at `nextOffset`, which covers skipped trailing lines; offsets stay byte positions (`position + index + 1`).
- The staging triggers (500 rows, 4 MiB) are unchanged. A trigger drains the queue in sub-transactions of `limit` rows. `limit` starts at 64; after each successful transaction it becomes `clamp(floor(8 * attempted / elapsedMs), 16, 500)`, growing at most 2x per step. Attempted rows include ignored duplicates, so failed attempts, busy waits and metadata-only commits never feed the sample.
- `yield` follows every sub-transaction except the last one of a drain, so the generator never suspends with a transaction open and no yield follows the final commit. Busy retries keep the identical prefix and checkpoint (40 retry yields, as today). `beforeWrite` and `assertSourceUnchanged` run on every attempt, and the queue, count and adaptive estimate change only after a successful COMMIT.
- Timing claim: 25 ms is a slice target with whole-step overshoot, because `driveFlight` checks after `steps.next()` returns (`indexer.ts:533`). A step may combine a drain's last transaction with parsing or publication. Adaptation bounds the transaction part near 8 ms; it is not a hard bound.
- Completion metadata (source size, mtime, builtAt) is written only by the final drain's last transaction, as today.
- `IngestOptions.now?: () => number` is a test seam; it defaults to `performance.now`.

Rejected: D4 (typed yields that force a timer turn per commit) — scope and performance. Adaptive transactions keep steps near the target within the existing slice driver, and more timer turns would lengthen the rebuild. D5 (serving `synchronous` policy) — out of scope. Worker migration — remains the follow-up D2 from 020.

## Tests (NEW `tests/usage/request-history-ingest-subtransactions.test.ts`, registered on an existing layout line and in the expected fixture)

1. Adaptation with a scripted clock: a slow transaction shrinks the next prefix; cheap ones grow it at most 2x; an all-duplicate prefix still adapts.
2. Stop and resume: stop the generator (`.return()`) right after a prefix commit. At interruption the stored offset equals that prefix's last row end and the committed rows match exactly. A fresh ingest from the stored offset ends with exact unique rows (the first payload of a duplicate id wins), the stored offset equals the ledger size, and no duplicates.
3. Mixed lines (blank, invalid, oversized, CRLF, multibyte, unterminated suffix) around prefix boundaries: interrupted plus resumed equals uninterrupted.
4. Busy: a second connection holding the write lock blocks the prefix with no offset or count movement; after release the same prefix commits exactly once. Separately, exhaustion (more than 40 retries) throws.
5. Staleness: replacing the ledger between prefix yields rejects with `RequestHistoryIndexStaleError`; a `beforeWrite` that throws (generation superseded) stops the write.
6. MEMORY journal rollback: on a MEMORY-journal connection configured like the build, a failure injected after several inserts in one transaction reverts the rows, offset and count. The actual build connection reports `memory` during ingest, and the published generation reports `wal`.
7. Private-build cleanup: interrupting a rebuild after at least one committed sub-transaction publishes no generation, and the unpublished build and its sidecars are removed.

Audit Plato (NEAR-PASS) additions:

- Tests 1–6 run against both a MEMORY-journal connection (the build configuration) and a WAL connection (the serving tail configuration), including an overlapping-tail case on WAL.
- Independent metadata oracles: intermediate prefixes leave `source_size`, `source_mtime_ms` and `built_at_ms` unchanged, and only the final successful transaction updates them. Further cases: an empty or skipped-only input, skipped trailing lines, an EOF exactly at the staging boundary (a metadata-only final commit), and an unterminated suffix. The offset stays at the last LF; once the suffix is completed it is ingested exactly once.
- A busy retry leaves the adaptive estimate unchanged, shown by the next prefix size under the scripted clock.
- Residuals stated rather than claimed fixed: publication still runs final metadata, the WAL switch, close, rename and reopen in one step (`indexer.ts:453`). A WAL autocheckpoint inside a serving tail COMMIT cannot be split. Runner storage or scanner stalls and descheduling remain possible. The hosted 508 ms is mitigated by the measured mechanism; it is not attributed with certainty.

## Acceptance

- Windows desktop tracer run: maximum step and lag recorded together with rebuild time.
- Required: the unchanged responsiveness assertion (lag < 300 ms) passes in hosted windows 6/9 on the exact pushed PR head. Recording lag alone is not acceptance.
- Focused history tests; typecheck, structure, privacy, ratchet and layout guards with Bun 1.4.3.
- Independent sol review, then push (authorized) and report the PR #7009 CI.
