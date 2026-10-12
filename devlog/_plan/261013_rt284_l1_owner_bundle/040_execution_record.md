# 040 — execution record (wp1 + wp2)

The repairs were implemented inside the wp1 cycle (commit `075f4ea68e`). This record closes wp2 against that evidence.

| Item | Evidence |
|---|---|
| Squash stack | `f8b2ef49e5` (#6986) … `ecf9ac55d4` (#6961); `git diff 94c50a564d ecf9ac55d4` is empty (tree equals the trial prefix) |
| R1 path separator | `src/routing/history/schema.ts` uses `path.join`; two tests assert `dirname(dbPath)` |
| R2 health indexes | schema v3 adds `idx_requests_provider_model_ts` and `idx_requests_attempts_ts`; the production SQL is exported from `src/routing/health.ts`; the new test `tests/usage/request-history-health-query-plan.test.ts` has 4 cases |
| Responsiveness test | start-snapshot latency list plus separate completion counters; the 300 ms, 1000 ms and `>= 5` bounds are unchanged |
| Guards | typecheck, structure:check, privacy:scan exit 0; layout, tooling, ratchet and hygiene 44 pass; layout.json 1999 lines |
| Focused receipt | 17 files, 440 pass / 0 fail (`.codexclaw/evidence/<session>/test-receipt.json`) |
| test:changed | 40298 pass / 115 skip / 20 fail. 17 pass serially on the head (contention with a concurrent lane run). The 3 `cli-access-audio-live` failures reproduce on clean dev through the same wrapper and pass directly. No failing file is changed by the bundle. |
| Plan audit | Pauli NEAR-PASS, 2 blockers folded |
| Exact-head review | Maxwell PASS at `075f4ea68e` |

## Deferred to the coordinator

- Hosted Windows confirmation for windows 5/9 and 6/9 after the push.
- D2 worker migration for the history index (arbitrary disk latency), as a follow-up issue.
- D5: refresh both shard duration tables from the final dev lane=all logs. 13 bundle test files currently weigh the median.
- #6994's windows 1/9 failure (#7000 EBUSY) is fixed by #7001 in lane L2.
- #6986's body says `Closes #6984`, so lane L3's #6984 may already be covered here.

