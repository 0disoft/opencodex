# Verification

Current local check: 2026-10-13, Linux, Python 3.12.14 and aiohttp 3.14.4.
This integration preserves prior PR head
`d4405a8bc14bf0e7af3a7c5b38eb79d331af620b` and merges trusted `dev`
`6da2774369aa32552e318e333902499683d053bc` without rewriting branch history.
Both integrations were conflict-free. Probe and workflow source is byte-identical
to the prior PR head; this follow-up updates verification metadata only.
The PR difference from this `dev` snapshot remains nine research/workflow files.
All inputs, accounts, tokens, thread ids, and database rows are synthetic.
No native Codex process, user home, installed config, or real service was accessed.

The 63 Python probes, 127 Bun tests, and repository gates below were executed on
the `3bb7a561` integration, committed locally as
`f53277df9e73ff8839107431680bbb1695792604`. The subsequent `6da27743` integration
changes only the project version from 2.84.0 to 2.85.0 in `package.json` and
`desktop/src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`. Probe, workflow, test,
runtime, and test-runner source plus dependency pins remain byte-identical;
`package.json` differs only in its version value. Those 190 tests were not
repeated for this metadata-only follow-up. The current integration's privacy
scan and diff check were rerun. The release version check confirmed all four
sources carry 2.85.0; the focused working-tree version test passed (one test,
two assertions, nine tests filtered out). No hosted CI result is claimed for it.

From the repository root:

```sh
cd devlog/_plan/260928_remote_thread_provider_policy/probes
python3 -m unittest -v test_native_policy test_probe test_loopback_bridge
```

**Inventory and local execution on the `3bb7a561` integration: 63 tests, 0 failures, across three suites.**

- 23 tests specify the proposed native policy: opt-out, trusted-origin scoping,
  explicit arrays, null semantics, parent/ancestor exceptions, immutable policy,
  exact ids, UUID thread-id validation, and synthetic paginated fixture reads.
- 29 retained raw-frame tests cover the relay alternative's ordinary/single-chunk
  rewrites, byte-identical pass-through, limits, and unsupported inputs.
- 11 localhost HTTP/WebSocket tests use a mock host and mock backend,
  checking two-way traffic, fixture auth/headers, explicit filters, enrollment,
  unrelated HTTP, fixture endpoint restrictions, and both directions of close-code
  forwarding.

The 23 + 29 offline tests use the Python standard library only. The 11 socket tests
need aiohttp; no production dependency manifest is changed.

Historical author-local execution on 2026-09-28 covered the 52 standard-library tests
(test_native_policy + test_probe); the socket suite was not part of that recorded
run. The then-current socket inventory was 9 tests. The
devlog-probes workflow added by this PR installs aiohttp as a required step (the
step fails the job if install fails) and discovers every devlog/**/probes
directory. The retained record for head `787ef30698` reports 61 hosted tests.
The later close-code regressions raised the count to 63. PR CI run `36492693336`,
job `109164783438`, is associated with head `f43e66b3`, but its checkout log records
the PR merge ref at `7b2ec3931dcd92f777a642c464d80990e7f38008`; that checked-out
merge ref passed all 63 tests. Run metadata's head SHA is not the checkout SHA.
The current local execution above independently ran all three suites. Each new
PR head needs its own associated hosted results; old runs do not attest to a new
integration commit. The workflow retains its normal merge-ref checkout behavior.

```sh
python3 -m unittest -v test_native_policy test_probe
```

The synthetic database has 5,200 `openai` rows, one `opencodex` row, and one `other`
row. Default filtering yields one; the two-id opt-in yields 5,201; all providers
yields 5,202. Page sizes 1, 37, and 1,000 are exercised. The fixture dump hash stays
unchanged after reads. This demonstrates the specification, not native SQLite
schema compatibility or actual mobile results.

## Repository checks

The current isolated Linux worktree uses runtime Bun 1.4.2 and the repository
selected test runner Bun 1.4.3. These checks passed on the `3bb7a561` integration:

```sh
bun run typecheck
bun run structure:check
bun run privacy:scan
bun run skill:surface:check
bun scripts/test-layout/plan.ts
bun scripts/file-size-ratchet.ts
git diff --check 3bb7a5612c35c8079f5683a6d408a6907cf98bbe
```

The official wrapper selected Bun 1.4.3 through `OCX_TEST_RUNNER_BUN` for:

```sh
bun run test --parallel=1 ./tests/test-layout.test.ts \
  ./tests/test-layout-tooling.test.ts \
  ./tests/ci-workflows/file-size-ratchet.test.ts \
  ./tests/ci-workflows/structure-ssot.test.ts \
  ./tests/ci-workflows/repo-hygiene.test.ts \
  ./tests/ci-workflows/ci-scope-gaps.test.ts
```

All 127 tests passed (941 assertions, no failures or skips). The layout planner
reported zero moves and zero unresolved files; all nine generated management
surface files were current. No generated output needed regeneration. The checks
cover the merged layout, repository hygiene, and current CI runtime/test-runner
roles; the Python suites exercise every executable specification this PR adds.

The earlier Windows run (Python 3.14.3, aiohttp 3.14.3) and fixed-disk workaround
are historical environment evidence, not the environment used for this refresh.
The full local Bun suite was not rerun: this PR changes only the research unit
and probe workflow relative to `dev`, and concurrent worktrees share this
validation environment. All 63 focused probes, the 127 focused Bun tests, and the applicable static
gates were run instead. Wider repository coverage remains for CI associated with the
new PR head, using the normal PR merge ref. No test budget or assertion was relaxed.

The version-only follow-up used:

```sh
bun scripts/release-version-sources.ts check 2.85.0
bun run test --parallel=1 ./tests/ci-workflows/release-version-sources.test.ts \
  -t 'every version source in the working tree carries package.json'
bun run privacy:scan
git diff --check 6da2774369aa32552e318e333902499683d053bc
```

## Hosted checkpoint and review boundary

For the previous PR head `b3ff2be3c65e84aac0ceeedb343d107359da114d`, maintainer
review confirmed that probe job `110273026033` checked out merge ref `1b40f8a`
(incorporating that head into `0328373`) and ran all 63 tests successfully.
That is historical evidence; it does not attest to this new `6da27743` integration.
New associated run/job links, actual checkout SHA and tree must be recorded in
the PR checkpoint after those checks complete. Run metadata alone is not checkout
evidence, and no prior green result is relabeled as a new-head pass.

The 2026-10-02 maintainer response dismissed only superseded correctness requests.
It did not approve the RFC or waive independent workflow/boundary review.
The PR remains Draft pending explicit maintainer workflow/security approval and
an exact-head readiness decision. The author's later independent static-review
evidence and hosted probe results concern the prior `d4405a8b` checkpoint; they
do not replace the maintainer's approval or waive the hold. A green CodeRabbit check caused by
Draft skipping is not a completed CodeRabbit review.

## Not executed / not established

- Native Rust implementation, compilation, config/schema generation, or native tests.
- Actual ChatGPT mobile pairing, full pagination, resume, token renewal, or reconnect.
- The full local OpenCodex Bun suite, and new current-head-associated hosted checks until that
  run completes. The earlier 52-test local run and 61-test hosted record remain
  historical evidence only.
- Production multi-segment relay support or management/security review.

The PR adds this research unit plus one workflow that runs it: devlog-probes.yml
is a new CI lane, so the executable contract now executes on the PR merge ref rather
than only locally. No executable configuration, release artifact, or native
storage is changed. Explicit maintainer workflow/security approval remains outstanding even with green CI.
