# 6990 — routing-history rebuild off the serving event loop

The request-history index is refreshed and, when its schema, source identity or file is
wrong, rebuilt from `usage.jsonl` inside one synchronous call. Routing reaches that call
through `openRequestHistoryIndexSync()` in `src/routing/health.ts`, so on a 2.34 GB ledger
one rebuild froze every request in the proxy for 487 s (issue #6990). This unit makes the
refresh cooperative: work runs in bounded steps that yield to the event loop, a full
rebuild is written to a private file and published as a new index generation, and routing
receives "evidence unknown" while the work finishes in the background. Operators get a
responsive proxy during a rebuild and a `last_error` that names the check that fired; the
indexed rows do not change.

## Loop spec

- Loop archetype: satisfy-spec, single work-phase (wp1).
- Trigger: issue lidge-jun/opencodex#6990, assigned in this session.
- Goal: `/healthz` and routed requests keep answering while the index rebuilds; rebuilt
  rows and meta match the current implementation.
- Non-goals: changing `usageLedgerMaxBytes` defaults; Lab code; schema version change; the
  live service on :10100, `~/.opencodex`, the Codex app and the GOAT server.
- Verifier: `bun test tests/usage/request-history-index.test.ts`, the new
  `tests/usage/request-history-rebuild-off-loop.test.ts` (event-loop lag bound, HTTP probe
  during an unfinished rebuild, busy contract, cancellation, resume, generation switch,
  equivalence), `tests/server/health-scoring.test.ts`, `tests/routing/routing-analytics.test.ts`,
  `tests/lab/core-lab-boundary.test.ts`, `bun run typecheck`, `bun run test:changed`,
  `bun run structure:check`, `bun run privacy:scan`, `bun run lint:gui` not needed (no gui);
  scratch differential run of the new indexer against the origin/dev indexer on one ledger.
- Stop condition: PR against dev opened with independent review PASS recorded and handed to
  the merge-management thread; no merge from this lane.
- Memory artifact: this unit plus the PR description.
- Expected terminal outcomes: DONE with the PR open and exact-head CI observed; NEEDS_HUMAN
  only for permission or publication limits.
- Escalation: reviewer FAIL that needs a contract change beyond this file map; any need to
  touch the live service.
- Resource bounds: none stated; host limits apply. Tool scope: this worktree, a disposable
  scratch worktree under /tmp, GOAT delegate_task (gpt-6.1-sol high), gh for the PR.

## Current code (origin/dev dc45bb2ca9)

- `src/routing/history/indexer.ts:432` `refreshLockedSync()` runs open, schema/identity
  check, `destroyAndRecreate()` and `fullRebuild()` in one call stack.
- `indexer.ts:319` `isHealthy()` runs `PRAGMA quick_check` on every refresh.
- `indexer.ts:438` overwrites the specific reason stored by `destroyAndRecreate()`.
- `indexer.ts:472` `openRequestHistoryIndex()` wraps the same sync work in `Promise.resolve`.
- `indexer.ts:328` `destroyAndRecreate()` unlinks the database and its `-wal`/`-shm` while
  other processes (`ocx logs rebuild-index`) may hold them open.
- `src/routing/health.ts:236` calls the sync entry at routing time and maps any throw to
  unknown evidence (`health.ts:329`); results, including unknown, are cached 1.5 s.

## Design

- D1 Ingest (`history/ingest.ts`) is a generator that yields after each 64 KiB read chunk and
  stops at the ledger size seen when it started. Each batch transaction writes rows,
  `indexed_offset` and `indexed_rows`; counts are read inside the transaction so two
  processes tailing one generation cannot overwrite each other, and the local count
  advances only after COMMIT. Before every commit the ledger path must still name the
  inode being read and must not have shrunk, otherwise the refresh is stale and restarts
  (at most 3 times). SQLITE_BUSY on a commit yields and retries.
- D2 One flight per process owns the refresh generator. Steps are bounded: setup, one
  ledger chunk, or publication. Async callers drive 25 ms slices separated by
  `setTimeout(0)`; a flight with no awaiters has its rejection handled at creation.
- D3 `openRequestHistoryIndexSync()` starts a flight only when none exists, drives whole
  steps until a 50 ms deadline, then hands the flight to the background driver and throws
  `RequestHistoryIndexBusyError`. It never drives a flight already running, so one routing
  decision pays the budget at most once. Single SQLite statements can still overrun; a
  small ledger is one step.
- D4 Generations (`history/generations.ts`): the index lives in `<config>/routing-history/`.
  A rebuild writes `b<ms>-<pid>-<seq>.sqlite` (rollback journal, synchronous off), rechecks
  the ledger identity, switches the file to WAL, closes it and renames it to the never-used
  name `g<ms>-<pid>-<seq>.sqlite`. Readers open the newest `g…` name. No file is renamed over
  an open database and SQLite side-file names never repeat, so a process publishing a
  generation cannot delete another process's WAL by name. Older generations, abandoned
  builds of dead processes and the legacy `routing-history.sqlite` files are unlinked after
  publication; a file still open on Windows is retried after the next publication.
- D5 Each refresh lists the directory and switches to a newer generation published by
  another process; a tail ingest checks before each commit that its generation is still the
  newest and restarts otherwise.
- D6 No `quick_check` on the refresh path. Statements that report SQLITE_CORRUPT/NOTADB
  (refresh, ingest, queries, routing health) mark the index for rebuild with reason
  "integrity error; index rebuilt". BUSY is transient and never triggers a rebuild. The
  serving connection uses `busy_timeout = 25`.
- D7 The specific rebuild reason is written into the build and survives publication.
- D8 `closeRequestHistoryIndex()` cancels a flight synchronously with `generator.return()`:
  nested `finally` blocks finalize statements, close the ledger fd and the build handle and
  delete the unpublished build; waiters reject with `RequestHistoryIndexClosedError`. A
  timer of a closed flight never runs it again.
- D9 Reader contract: sync callers get a caught-up index or busy. Async callers await the
  flight and read rows and meta from the same generation handle: the previous complete
  index plus a committed tail prefix, or a newly published rebuild. During a rebuild the old
  generation handle is closed, so stale rows are unreachable.
- D10 Health cache: entries remember `requestHistoryIndexEpoch()`, which advances when a
  rebuild publishes or a background flight finishes, so unknown evidence cached during a
  rebuild is recomputed on the next routing decision after it.
- D11 Manual rebuild (`ocx logs rebuild-index`) waits for a running flight and then runs a
  forced flight through the same driver.

Amendments from the independent audit (D1 byte cap, D4 background reclamation, D9 read
helper, D10 epoch, D12 parking) are recorded in `020_audit.md`.

## File map

- `src/routing/history/indexer.ts` — flight, drivers, publication, public API.
- `src/routing/history/ingest.ts` (new) — row extraction, ingest generator, SQLite error classes.
- `src/routing/history/generations.ts` (new) — generation naming, selection, cleanup.
- `src/routing/history/schema.ts` — `HISTORY_DIRNAME`, `historyIndexDir()`.
- `src/routing/health.ts` — epoch-bound cache, report corruption-class errors.
- `src/routing/analytics.ts` — header comment names the directory.
- `tests/usage/request-history-index.test.ts` — fixed-path fixtures use `meta.dbPath`.
- `tests/usage/request-history-rebuild-off-loop.test.ts` (new) + both layout registrations.
- `docs-site/src/content/docs/reference/configuration/routing.md` — directory, background rebuild,
  unknown evidence meanwhile.
- `structure/dashboard-and-usage.md` — reader contract sentence.

## Architect consultation

Recorded in `010_architect.md`.

