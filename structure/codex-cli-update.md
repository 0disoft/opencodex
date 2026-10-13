# Codex CLI Update Plan

`src/codex/cli-update-plan.ts` constructs the read-only update plan;
`src/codex/app-server-processes.ts` supplies its process observation.
Installation inspection follows the [runtime inspection contract](runtime.md#lifecycle),
and explicit Windows observation follows its [separate read-only contract](runtime.md#explicit-codex-cli-installation-observation).

The read-only CLI update plan binds npm executable selection to the inspected launcher PATH.
Its child environment drops npm configuration overrides, named Node startup/output controls,
and the `LD_*`/`DYLD_*` loader families; proxy settings and `NODE_EXTRA_CA_CERTS` remain supported.
Distinct npm config files, cache and logs stay under the owned temporary root with best-effort
cleanup; a cleanup error does not replace the computed plan/refusal. The POSIX update
scan includes all readable users by default, retaining an explicitly injected UID scope.
Linux per-process `status`/`cmdline` read failures invalidate the scan except for `ENOENT`
(a process that disappeared); incomplete observation refuses with `blocked_process_state_unknown`;
the restart/kill path remains same-user. This plan neither installs a runtime nor signals
an existing Codex session. Windows enumeration/installation limits remain unchanged.
