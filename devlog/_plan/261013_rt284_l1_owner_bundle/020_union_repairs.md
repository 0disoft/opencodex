# 020 — wp2 union repairs

Architect consultation: sol agent Dalton (`01a130cb-4d8a-73b3-a2c8-1db866a53f32`), proposal D1–D6. A measurement probe (Carver, `/private/tmp/rt284-l1-probe/REPORT.md`) timed every synchronous step of a cold 120k-row rebuild.

## Main dispositions

- **D1 accepted.** Use native path joining in the history path helpers.
- **D2 rejected for this train.** The worker migration rewrites #6999's architecture and expands into health, analytics, packaging and lifecycle. It goes to the coordinator as a follow-up issue. The measured narrow cause is fixed instead (R2).
- **D3 partly accepted.** The 300 ms lag and 1000 ms probe bounds stay unchanged. No barrier rewrite in this train.
- **D4 accepted, no change.** Runner pin 1.4.3 and runtime 1.4.2 stay as #6986 set them.
- **D5 deferred to the coordinator.** Refresh both duration tables from the final dev lane=all logs. Unrecorded files weigh the median until then (`scripts/ci/run-bun-test-batches.sh:291`).
- **D6 not applicable to L1.** The owner stack keeps layout.json at 1999 lines. #7003 in L2 is what reaches 2000.

## R1 — Windows path separator (windows 5/9, commit "fix(history): ...", repairs #6999)

MODIFY `src/routing/history/schema.ts` (lines 75–81):

```diff
+import { join } from "node:path";
 export function historyIndexPath(configDir: string): string {
-  return `${configDir.replace(/[\\/]+$/, "")}/${HISTORY_DB_FILENAME}`;
+  return join(configDir, HISTORY_DB_FILENAME);
 }
 export function historyIndexDir(configDir: string): string {
-  return `${configDir.replace(/[\\/]+$/, "")}/${HISTORY_DIRNAME}`;
+  return join(configDir, HISTORY_DIRNAME);
 }
```

MODIFY `tests/usage/request-history-rebuild-off-loop.test.ts:288` and `tests/usage/request-history-index.test.ts:113`:

```diff
-expect(meta.dbPath.startsWith(historyIndexDir(getConfigDir()))).toBe(true);
+expect(dirname(meta.dbPath)).toBe(historyIndexDir(getConfigDir()));
```

This is a stronger assertion: the file sits directly in the directory. A regression case runs only on win32. On POSIX `join` already matches, so the test change is the portable guard.

## R2 — routing-health scan after publication (windows 6/9, repairs #6999)

Evidence: `src/routing/health.ts:244` runs two synchronous queries at routing time. The candidate query (`provider = ? AND model = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 100`) selected and sorted 60,000 rows. The attempt query (`timestamp >= ? AND attempt_count > 1 ...`) walked the whole window. Together they took 111 ms on an M5 Max, against 11.7 ms for the longest rebuild step, so they are the plausible source of the 545 ms Windows stall. With the indexes below they took 0.76 + 1.73 ms and returned identical evidence (`/private/tmp/rt284-l1-probe/health-index-probe.json`).

MODIFY `src/routing/history/schema.ts`:

```diff
-export const HISTORY_SCHEMA_VERSION = 2;
+export const HISTORY_SCHEMA_VERSION = 3;
 ...
 CREATE INDEX IF NOT EXISTS idx_requests_profile ON requests(profile_id);
+CREATE INDEX IF NOT EXISTS idx_requests_provider_model_ts ON requests(provider, model, timestamp DESC);
+CREATE INDEX IF NOT EXISTS idx_requests_attempts_ts ON requests(timestamp DESC) WHERE attempt_count > 1;
```

The version bump makes an existing generation rebuild privately, in cooperative slices on the serving loop, so the indexes always exist. A released 2.83 process reads only the legacy single-file index, so it never trades rebuilds with 2.84. An unreleased generation-aware v2 dev build running at the same time could alternate rebuilds with v3, because newest-generation selection ignores schema (`generations.ts:44`). This is accepted as a dev-only residual.

Index coverage is narrower than "bounded":

- `(provider, model, timestamp DESC)` serves the equality filter and the order (`health.ts:252`). The optional `api_key_id` predicate (`health.ts:248`) is still a residual filter, so sparse account matches can examine many candidate rows.
- The partial index removes single-attempt rows from the attempt query. Its two leading-wildcard `LIKE` predicates and the target exclusion (`health.ts:264`) stay residual, so many nonmatching multi-attempt rows can still be scanned.
- The rebuild still runs synchronous steps cooperatively on the serving loop (`indexer.ts:533` checks the budget after each step). Arbitrary disk latency is unresolved and goes to the coordinator as the D2 follow-up. The Windows attribution stays a hypothesis until hosted CI runs on the repaired head.

MODIFY `src/routing/health.ts`: hoist the two SQL texts into exported builders, `healthCandidateSql(withAccount: boolean)` and `HEALTH_ATTEMPT_SQL`, used by `computeHistoricalHealthEvidence` with unchanged text and bindings. The test then plans the production SQL. If the file's ratchet cap is tight, the builders go in a sibling `src/routing/health-sql.ts`.

NEW test (a sibling file, registered on an existing line of layout.json and in the expected fixture): `tests/usage/request-history-health-query-plan.test.ts`.

1. On a built v3 generation, `EXPLAIN QUERY PLAN` with the default planner (no `INDEXED BY`) and the production SQL and bindings, including escaped selectors and the target exclusion. The candidate query, with and without an account, uses `idx_requests_provider_model_ts` with no `USE TEMP B-TREE FOR ORDER BY`. The attempt query uses `idx_requests_attempts_ts`.
2. Behavior on a fixture with multi-attempt rows, at fixed `now`: a cross-target attempt match contributes samples, same-target rows are excluded from the attempt set, and account filtering isolates samples.
3. v2→v3 migration: hand-build a v2-shaped generation (version meta `2`, both new indexes absent) with a canonical ledger. Opening the index publishes a new generation path with version `3`, both indexes present, and identical rows and offset. A reader holding the old generation open keeps working until it releases.

4. Released upgrade path: a genuine legacy v2 single-file database (as 2.83 writes it, at `historyIndexPath`) with a canonical JSONL ledger. Opening the index publishes a v3 generation with canonical rows and offset and both indexes, leaves the ledger bytes unchanged, and keeps an initialized legacy reader working until it releases.

MODIFY `tests/server/server-history-rebuild-responsiveness.test.ts` (stricter, bounds unchanged). The existing `length >= 5` counters keep counting only probes that completed while the rebuild was running. A separate latency list takes every probe whose own start snapshot saw `rebuilding === true`, including ones that finish after the rebuild settles, and the 1000 ms bound applies to that list. Today the `if (rebuilding)` guards at lines 139, 150 and 162 drop exactly the publication-adjacent samples.

MODIFY `structure/dashboard-and-usage.md` (around line 282): replace "off the serving event loop" and "at most 50 ms" with cooperative wording. The rebuild runs in budgeted slices on the serving loop; an individual synchronous step can exceed the slice; the health queries are index-backed.

## Acceptance

- Focused tests: `tests/usage/request-history-index.test.ts`, `tests/usage/request-history-rebuild-off-loop.test.ts`, `tests/server/server-history-rebuild-responsiveness.test.ts`, the new plan test, `tests/server/health-scoring.test.ts`, `tests/routing/routing-analytics.test.ts`, and `tests/claude-integration/claude-native-affinity.test.ts`.
- Guards: typecheck, structure:check, privacy:scan, file-size ratchet, test-layout, and test-layout-tooling.
- Windows confirmation needs hosted CI after the coordinator pushes. Until then it is reported as pending, never as passed.

