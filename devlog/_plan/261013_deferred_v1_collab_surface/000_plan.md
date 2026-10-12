# Deferred V1 collaboration surface (#6844 remainder) and #6984 verification — lane L3

Release train 2.84.0, lane L3, branch `codex/rt284-issues-proxy` from `origin/dev` `3e58c2ce3e`.
Coordinator thread `01a130be-2e10-7af0-adf9-efca9fe37e30` owns push, PR, merge and release.

## Objective

1. #6844 remainder. PR #6977 made `collabSurface()` read V1 tools that codex-rs renders inside the
   code-mode `exec` description. When the model supports tool search (every OpenCodex catalog row),
   codex-rs registers V1 as **deferred** and renders none of it, so those turns stay `null` and never
   receive the V1 Max/Ultra proactive guidance. Add a second, positive-only evidence source: the
   developer `<tools>` world-state fragment that lists deferred tool namespaces.
2. #6984. Verify that owner PR #6986 (lane L1, "Closes #6984") fixes the picker relay on Bun 1.4.2 and
   1.4.3 and record the residual. No listener change in this lane: a parallel edit of
   `src/claude/intercept/picker-listener.ts` would conflict with L1's stack.

## Evidence (codex-rs `openai/codex` @ `16845bb8e8`, 2026-10-12)

- `core/src/context/world_state/tools.rs:29-147` — `ToolsState` renders a **developer** fragment
  `<tools>\nDeferred tool namespaces:\n- <ns>[: <first line, <=250 chars>]\n...</tools>` the first time,
  then only diffs `Added deferred tool namespaces:` / `Removed deferred tool namespaces:`, and
  `No deferred tool namespaces remain.` when empty (`:159`). Omitted rows render
  `... <n> additional namespaces omitted.` (`:203-210`); the fragment is capped at 4 KiB (`:25`);
  names are reserved before descriptions (`tools_budget.rs:27-69`), so a row may be name-only.
- `core/src/session/world_state.rs:318-326` adds the section only when `Feature::DeferredToolWorldState`
  is enabled; `features/src/lib.rs:1572-1575` marks it UnderDevelopment, default off. Codex Desktop
  sessions routed through OpenCodex were observed receiving it (`- multi_agent_v1: Tools for spawning and
  managing sub-agents.`). Feature-off clients stay undetectable — documented, not claimed fixed.
- `core/src/tools/spec_plan.rs:1561-1588` registers V1 tools with `ToolExposure::Deferred` when
  `supports_search_tool`; `core/src/tools/handlers/multi_agents_spec.rs:14` fixes the namespace
  `multi_agent_v1`. V2 tools are `Direct`/`DirectModelOnly` (`spec_plan.rs:1468-1472`), never deferred.
- OpenCodex: developer items reach `parsed.context.messages` with role `developer`
  (`src/responses/parser.ts:318-330`); no OpenCodex code injects or strips `<tools>` items.
  Structured `tool_search` tools carry `toolSearch: true` (`src/responses/parser-tools.ts:120-128`).

## Architect consultation (gpt-6.1-sol, agent 01a130cb-020d-78e3-bd33-396cb4d12bfb)

| ID | Proposal | Main disposition |
|---|---|---|
| D1 | New `deferred-collab-surface.ts`, read developer messages only, standalone `<tools>` fragments | Accepted |
| D2 | Ordered replay: snapshot replaces, added adds, removed removes, empty clears; omitted removals invalidate carried membership; omitted additions never establish; malformed fragment clears carried evidence | Accepted |
| D3 | Host coherence: genuine code-mode exec (existing guards) or a structured `toolSearch` tool; expose rendered foreign-collab claim even without rendered V1 | Accepted |
| D4 | Combination in `collabSurface()` mirrors #6977; deferred evidence never yields V2 | Accepted |
| D5 | Docs: `structure/subagents.md`, English `sub-agent-surface` guide, stale helper comments | Accepted; commit says "Refs #6844", closure is the coordinator's decision because feature-off clients remain undetectable |

Architect for #6984 (agent 01a130cb-02bd-77d2-9f9b-2feaac02de82) proposed a raw-TLS h1 transport
rewrite (D1-D6). Disposition: **rejected for this lane** — #6986 already lands a targeted listener fix
with tests green on Bun 1.4.0/1.4.2/1.4.3; the rewrite is a separate design. Residual recorded: the
post-EOF ciphertext drain added by #6986 has no deadline.

## Work-phase map

| Phase | Doc | Outcome |
|---|---|---|
| wp1 | `010_deferred_v1_evidence.md` | Commit: deferred V1 evidence + tests + docs |
| wp2 | `020_6984_verification.md` | Verification record of #6986; no code |
| wp3 | — | Gates, independent sol review of final head, status report |

## Out of scope

Push, PR, merge, issue comments, `picker-listener.ts`, other lanes' files.

