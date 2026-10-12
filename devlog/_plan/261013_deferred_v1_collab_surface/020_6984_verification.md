# 020 — #6984 verification (no code in this lane)

#6986 (owner PR, lane L1 bundle) states "Closes #6984" and patches
`src/claude/intercept/picker-listener.ts`: a closing h1 reply replaces the socket's `destroySoon` with
resume + graceful `end()`, the front sets `allowHalfOpen`, and on backend `end` unpipes and resumes the
client so the abandoned upload keeps draining.

Baseline at `origin/dev` `3e58c2ce3e` (lane worktree), `tests/claude-integration/claude-picker-upload.test.ts -t refusal`:
Bun 1.4.0 8/0; Bun 1.4.3 6/2 (buffered h1 400/503: `read ECONNRESET`); Bun 1.4.2 (darwin) buffered h1 503 hits the 4 s deadline.

At #6986 head `ad1540aa43` (`/private/tmp/rt284-lanes/L3-verify6986`): full upload file 22 pass / 0 fail,
three runs each on Bun 1.4.2 and 1.4.3.

Residual for a follow-up issue: after backend EOF the front drains client ciphertext with no deadline,
so a peer that trickles bytes can hold a socket until listener shutdown (before #6986 the same
connection hung, so this is not a regression).

