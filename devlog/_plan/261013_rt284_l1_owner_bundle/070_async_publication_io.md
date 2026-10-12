# 070 — publication file I/O off the serving loop (hosted windows 6/9, PR #7009)

## Evidence

The hosted run 38294441985 (job 114963676906, head `c8e95e830c`) carried the step instrumentation from 060:

```
{"rebuildMs":3291,"maxLagMs":667,"gaps":[{"gapMs":667,"cpuMs":31,"startMs":2613,"probe":"proxied"},{"gapMs":90,...},...],
 "longSteps":[{"phase":"ingest->published","ms":655,"atMs":2625}]}
```

One generator step spans the last ingest sub-transaction through publication. It blocked the loop for 655 ms while the process used 31 ms of CPU, so the loop was waiting, not working: on synchronous file I/O or through descheduling. Antivirus scanning of the new file remains a hypothesis. Every other gap was 90 ms or less. That step runs: the final meta transaction, `PRAGMA journal_mode = WAL` on the ~30 MB build, `build.close()`, `renameSync(build, generation)`, and `openGeneration` (`new Database`, busy timeout, WAL pragma, `existsSync`) (`indexer.ts:465–495`). A Windows desktop without antivirus never exceeds 50 ms there. Hosted runners most likely scan new files on close, rename or open.

## Changes (R5)

MODIFY `src/routing/history/indexer.ts`:

1. Flight steps may yield an I/O wait. The step type becomes `Generator<StepYield, Settled, unknown>` with `type StepYield = void | IoWait` and `interface IoWait { promise: Promise<void> }`. When `driveFlight` receives an `IoWait` it records it on the flight (`target.waiting`) and returns unsettled. `scheduleFlight` sees `waiting`, attaches `.then(resume, resume)` that clears `waiting` and schedules the normal `setTimeout(0)` slice, and returns; the slice timer is not armed while waiting. A sync entry that hits a wait hands off as busy, as it does for unfinished work today. A flight closed or superseded while waiting never resumes, because the resume checks `flight === target && !target.done` like the timer path does.
2. `function* awaitIo(promise: Promise<unknown>): Generator<StepYield, void, unknown>` captures the outcome (`.then` and `.catch` into a holder, so the promise is always handled), yields `{ promise: settled }`, and on resume throws the captured error.
3. Publication in `rebuildSteps` becomes separate steps with phase labels:
   - `publish-close`: the final meta transaction, `PRAGMA journal_mode = WAL`, `build.close()`. A plain `yield` precedes it, so it never shares a step with the last ingest transaction.
   - `publish-rename`: `yield* awaitIo(publishIo.rename(buildPath, generationPath))`, with `publishIo.rename = fs.promises.rename` running on the libuv threadpool. `published = true` is set after the await resolves.
   - `publish-warm`: `yield* awaitIo(publishIo.warm(generationPath))`, which opens the file asynchronously, reads its first 4 KiB, and closes it. On-access scanning and cold cache reads then complete off the loop. A warm failure is ignored (best effort); the synchronous open below still decides.
   - `publish-open`: `openGeneration`, `scheduleReclaim`, `settledFor`.
4. Cancellation: `closeRequestHistoryIndex` already calls `steps.return()`, which runs the `finally` (`if (!published) removeBuildFiles(buildPath)`). A rename still in flight then either finds no build file (rejection captured, nothing published) or completes first. In that case a complete, valid generation exists that the next refresh adopts as the newest generation, which is correct, because the build was finished before the rename started.
5. Test seam: `setRequestHistoryPublishIoForTests({ rename?, warm? } | null)`.

Unchanged: the prepare step (`mkdirSync`, `removeAbandonedBuilds`, the build `new Database`), with no hosted evidence of a stall; reclaim unlinks, which run one file per timer turn after settle; and the tail path.

## Tests (NEW `tests/usage/request-history-publish-io.test.ts`, registered on an existing layout line and in the expected fixture)

1. Held rename: a seam rename returns a promise the test resolves itself. While pending: at least 5 `setTimeout(0)` turns run, `openRequestHistoryIndex()` stays pending, no `g…sqlite` exists, the build file exists, and the step observer reports phase `publish-rename`. After the test performs the real rename and resolves, the read resolves with every row, the generation exists and the build is gone.
2. Rename rejection: the flight rejects with that error, the build files are removed, and no generation exists; the next refresh rebuilds successfully.
3. Held warm: the same loop-runs and pending assertions; a warm rejection still publishes.
4. Close while the rename is held: the read rejects with `RequestHistoryIndexClosedError` and nothing is unhandled. After the rename later resolves, a reopen adopts that complete generation, or rebuilds if the cleanup won the race, with correct rows either way.
5. Step split: with the observer, `publish-close`, `publish-rename`, `publish-warm` and `publish-open` appear as distinct steps, and no single step covers both the last ingest commit and the rename.
6. Sync entry: `openRequestHistoryIndexSync` on a cold index with a held rename throws `RequestHistoryIndexBusyError`, and the background flight completes once the rename resolves.

## Acceptance

Focused history tests and guards with Bun 1.4.3; the Windows desktop run; independent sol review; push; then the hosted windows 6/9 `maxLagMs < 300` on the exact head. If a hosted gap remains, the phase labels now name the exact sub-step.

## Architect consultation (Goodall, D1–D10) and main dispositions

- **Goal.** A measured mitigation for the hosted stall. Removing all publication I/O from the serving loop needs a SQLite-owning worker (D8). That is the follow-up already recorded as 020 D2. WAL conversion, close and `openGeneration` stay synchronous, but each runs as its own labeled step, so a residual gap names its sub-step.
- **D1 accepted.** The yield type is `void | IoWait`. `driveFlight` never advances a waiting generator (`if (target.waiting) return false`) and stops at an `IoWait` regardless of budget. Settlement only re-arms the existing `setTimeout(0)` driver, guarded by `flight === target && !target.done && target.waiting === wait`. A rejection comes back through the generator itself: `awaitIo` rethrows the captured error after resume, so `finally` blocks and the stale restart loop run.
- **D2 accepted, with labels** `publish-meta` (source check plus the final meta transaction), `publish-wal`, `publish-close`, `publish-rename` (IoWait), `publish-warm` (IoWait), and `publish-open` (open, validate, adopt, reclaim scheduling). Plain yields separate the samples; a forced turn boundary is not added, since attribution needs separate samples, not separate turns. Wait time is never counted as step time, because the step returns at the `IoWait`.
- **D3/D4 accepted.** A rename in flight owns its cleanup. The `finally` of `rebuildSteps` defers `removeBuildFiles(buildPath)` until the rename settles, and runs it only if the rename did not succeed. A rename that succeeds after close leaves a complete generation for normal adoption or reclamation; the generation path is never deleted by build cleanup. Deferred cleanups are tracked in a module set with a test-only `drainRequestHistoryIoForTests()`. Readers still get `RequestHistoryIndexClosedError` immediately. The contract becomes "readers cancel immediately; dispatched I/O settles safely".
- **D5 accepted.** After the warm and before adoption, check `sameLedger(revision, sourceIdentity())` and `newestGenerationPath(dir) === generationPath`; on mismatch throw `RequestHistoryIndexStaleError`, so the existing restart adopts the newest generation or rebuilds. ENOENT during the warm becomes Stale. Other warm errors are ignored, because the synchronous open decides; a rename error is preserved as-is.
- **D6 accepted.** The sync entry hands off as busy at an `IoWait`. A cold rebuild is therefore always busy until publication completes, which the documented contract allows. The handed-off epoch bump is preserved.
- **D7 accepted.** The warm uses `node:fs/promises` `open('r')`, reads at most 4 KiB, and closes in `finally`. The hooks are captured once per publication.
- **D9 partly.** Prepare and reclaim keep their synchronous fs work (no hosted evidence); their phase labels stay attributable. Conversion is follow-up.
- **D10 accepted** as the test list below plus teardown drains. The real responsiveness test keeps its bounds.

Tests (amended): held rename (timers and probes run, read pending, no `g…sqlite`, sync busy, rename invoked once); held warm after a real rename (generation exists, read pending, no adoption); rename rejection (error surfaced once, build removed, no generation, next refresh rebuilds); warm rejection (ENOENT leads to Stale and restart; other errors still publish); close during rename and during warm (immediate ClosedError, late completion cannot adopt or mutate the new lifetime, the drain completes, the reopened index has correct rows); ledger replacement during a wait (no obsolete rows; the restart obtains the current ledger); step split (distinct samples per publish phase).

The structure doc (`structure/dashboard-and-usage.md`) states the new publication contract.


Reflection (Goodall): ALIGNED. Implementation must: (1) record rename success in the publication resource, independent of generator resumption; (2) have the drain cover pending warms as well as deferred cleanups; (3) validate after the synchronous open and before global adoption, closing the candidate handle on failure; (4) carry a tagged outcome so a rejection with undefined is never success. This section supersedes the earlier R5 text on immediate cleanup and unconditional warm-error suppression.

## Audit round 1 (Gauss, FAIL) and amendments

1. **Cold sync reads keep their behavior (High).** The yield is an `IoRequest` with `runSync()` and `runAsync()`, and the generator receives a tagged outcome `{ ok: true } | { ok: false, error }` as the value of its yield, so a rejection with `undefined` is still a failure. `driveFlight(target, budgetMs, mode)`: in `sync` mode (`openRequestHistoryIndexSync`) it runs `runSync()` inline and continues within the budget, exactly as today, so small cold rebuilds still settle synchronously and `health-scoring.test.ts:83/203` keep their counts and rankings. In `async` mode (`openForRead` slices and the timer driver) it starts `runAsync()`, records the wait, stops, and resumes with `steps.next(outcome)` from the timer once it settles. The hosted stall was a background-driven publication; the sync entry never drives a flight another caller started (`indexer.ts:589`). Busy behavior for cold sync reads is unchanged. `health-scoring.test.ts` and `routing-analytics.test.ts` are in the verification set.
2. **Teardown (Medium).** Deferred I/O exists only for async-driven publications that close interrupts. `drainRequestHistoryIoForTests()` (pending renames, warms and deferred cleanups; a warm closes its descriptor before leaving the set) is awaited after close and before home removal in `tests/helpers/server-auth-fixture.ts` (the shared server close) and in the history test files that close during a rebuild (`request-history-rebuild-off-loop.test.ts`, `request-history-ingest-subtransactions.test.ts`, the new publish-io test). Paths and hooks are captured per publication, so a later reset cannot redirect them.
3. **Test matrix additions (Medium).** Immediately fulfilled and immediately rejected hooks; a rejection with `undefined`; a newer generation appearing during the warm (Stale, restart, newest adopted); invalidation after the synchronous open (the candidate handle is closed, no adoption); exactly one rename dispatch per publication attempt; a bounded restart; no adoption or epoch mutation by an old flight after close and reopen; held hooks released in `finally` before teardown drains; the sync-mode cold rebuild still settles inline with the same rows.
4. **Notes.** `StepYield` is propagated through every delegating generator signature. The step observer also records a sample when a step throws. The evidence section is narrowed: low CPU across a long step means a wait (I/O or descheduling) inside that step; it does not by itself prove which.


## Audit round 2 (Gauss, NEAR-PASS) folds

1. The flight owns a pending outcome (target.pendingOutcome). runSync() results and settled runAsync() results are stored there, and only the next guarded driveFlight call consumes them exactly once via steps.next(outcome), so a budget boundary after runSync() never replays the request. A synchronous throw, including undefined, becomes a tagged failure delivered through the generator. Test: expire the budget right after runSync(), resume asynchronously, and expect one dispatch and correct settlement.
2. The observer times driver-executed I/O (runSync, and the synchronous dispatch of runAsync) under the request phase, failures included; asynchronous wait time is excluded.
3. The earlier "always busy" test text is superseded: a sync-mode cold rebuild settles inline (round 1, item 1).
