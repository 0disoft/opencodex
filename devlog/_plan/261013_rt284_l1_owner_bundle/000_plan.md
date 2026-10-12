# L1 owner bundle — plan (000)

Lane L1 of the 2.84.0 release train. Coordinator thread `01a130be-2e10-7af0-adf9-efca9fe37e30` owns push, PRs, merges and release; this lane commits locally only.

- Worktree `/private/tmp/rt284-lanes/L1`, branch `codex/rt284-owner-bundle`, base `origin/dev` `3e58c2ce3ee5433901ed467fe87c32fb4b5c5e77`.
- Test runner: `OCX_TEST_RUNNER_BUN=/Users/jun/.cache/rt284-bun/bun-darwin-aarch64/bun` (Bun 1.4.3, required by #6986).

## Constraints

- One squashed commit per owner PR, in order, with no edits to the PR contents.
- Repairs land as separate commits that name the PR they repair.
- Do not weaken assertions or raise timeouts or bounds.
- `scripts/test-layout/layout.json` stays under 2000 lines (1999 on dev; the owner stack keeps it at 1999).

## Work-phase map

| Phase | Doc | Depends on |
|---|---|---|
| wp1 squash stack | 010_squash_stack.md | — |
| wp2 union repairs | 020_union_repairs.md | wp1 |
| wp3 review and report | 030_review_report.md | wp2 |

## Evidence gathered in P

- A trial squash of all nine PRs onto dev (`/private/tmp/ocx-rt284-trial-20627`) had no textual conflicts. Typecheck and structure:check passed on the trial.
- Hosted Windows failures (run 38260646423, PR #6999 head 8f1c6624fe):
  - windows 5/9: `tests/usage/request-history-rebuild-off-loop.test.ts:288` `startsWith(historyIndexDir(...))` fails because `historyIndexDir` (`src/routing/history/schema.ts:79`) joins with `/` while generation paths come from `path.join` (`src/routing/history/generations.ts:53`).
  - windows 6/9: `tests/server/server-history-rebuild-responsiveness.test.ts` reported `{"rebuildMs":5277,"maxLagMs":545,...}`, one probe at 1106.8 ms against a 1000 ms bound.
- The #6994 Windows 1/9 failure (run 38254923548) is the `codex-quota-auto-refresh` EBUSY from issue #7000. #7001 in lane L2 fixes it, so it is out of L1's scope.
- Shard durations (#6994): files missing from the table weigh the median (`scripts/ci/run-bun-test-batches.sh:291`), so the files this bundle adds need no table edit. Refresh them from the final dev lane=all run.

