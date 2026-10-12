# Cross-platform CI — decision recorded under "Cross-platform CI"

## Intent and constraints

Issue #6978 reports ordinary macOS shards approaching the 20-minute whole-job
deadline. Run 38214884055 at 8eb1fc3de365b019f9bacdcaacc6b7d284bd8d48
confirms that job 114697966974 spent about a minute in setup, then its batch step
was cancelled near that deadline. The reporter's log excerpt shows passing test
output four seconds before cancellation. This is evidence of insufficient job
headroom, not proof that every cancelled run was healthy or that a batch cannot stall.

## Alternatives

- Keep 20 minutes: retains the current cost ceiling but leaves the reported
  actively progressing run without setup headroom.
- Add a third shard or refresh duration weights: may reduce the critical path,
  but changes membership placement or runner cost and needs representative timing
  evidence beyond this cancellation.
- Increase only the whole-job deadline: preserves the tested batch shape and
  bounds while providing a small, explicit setup/runtime margin.

## Decision and consequences

Use 25 minutes for each ordinary macOS shard, retaining two shards, at most 12
files per process, one worker, a 300-second process deadline, the forced-reap
allowance and immediate failure on a timeout, crash or assertion failure.
The unsharded control keeps 75 minutes. Triggers, permissions, runner selection,
release eligibility and all other job budgets are unchanged.

This raises the worst-case per-shard wall-clock allowance by 25%; it does not
make tests faster or promise that the next hosted run completes. A source-as-data
regression pins both the job budget and unchanged process settings. Exact-head
hosted macOS completion remains required evidence before claiming the reported
cancellation resolved. Silent Bun exit stalls such as #4956 remain separate bugs.
