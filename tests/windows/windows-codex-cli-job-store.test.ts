/**
 * Windows Codex CLI update job store — the real handle-bound backend in
 * src/codex/cli-update-job-store-windows.ts exercised through the public
 * admit/run/read/finish API in src/codex/cli-update-job.ts, plus the
 * mixed-policy ACL parser in src/lib/windows-owner-acl.ts it consumes.
 *
 * Parser cases are pure and run everywhere. Backend cases require Windows x64:
 * they run the actual PowerShell ACL verifier and icacls hardening against a
 * private fixture under %TEMP%, so each case carries a real-subprocess budget.
 * Cross-account (other-SID) and ARM64 behavior are unverified by design.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { admitCodexCliUpdateJob, finishCodexCliUpdateJob, readCodexCliUpdateJob, runCodexCliUpdateJob } from "../../src/codex/cli-update-job";
import { codexCliUpdateUnjoinedWorkerCount, runCodexCliUpdateApplyInWorker } from "../../src/codex/cli-update-job-worker";
import { FIXTURE_CONTROL_WORDS, FIXTURE_RELEASE } from "../helpers/cli-update-fixture-worker";
import { setWindowsOwnerAclAsyncRunnerForTests, windowsEntriesAclMatches,
  type WindowsAclEntry } from "../../src/lib/windows-owner-acl";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { handleCodexCliUpdateRoutes } from "../../src/server/management/codex-cli-update-routes";
import { handleCodexCliUpdateCommand } from "../../src/cli/codex-cli-update";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { CodexCliApplyResult } from "../../src/codex/cli-update-apply";

const USER_SID = "S-1-5-21-9-9-9-1001";
const FOREIGN_SID = "S-1-5-21-8-8-8-2002";
const ADMIN_SID = "S-1-5-32-544";
const SYSTEM_SID = "S-1-5-18";
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const FULL_CONTROL = 2032127;
// Matches READ_MASK in src/lib/windows-owner-acl.ts: generic read/execute plus
// SYNCHRONIZE, READ_CONTROL and the attribute/EA/list bits. Nothing write-side.
const READ_ONLY_MASK = (0x80000000 | 0x20000000 | 0x100000 | 0x20000 | 0x80 | 0x20 | 0x8 | 0x1) >>> 0;
const CREATE_ONLY_MASK = 0x4 | 0x2;
const WRITE_BITS = 0x100 /* FILE_WRITE_ATTRIBUTES */ | 0x2 /* FILE_WRITE_DATA */;

function aclRun(user: string, tokenOwner: string, elevated: boolean, entries: readonly { owner: string; flags?: number; aces: readonly string[] }[]): string {
  const lines = [`U|${user}|${tokenOwner}|${elevated ? "True" : "False"}`];
  entries.forEach((entry, index) => {
    lines.push(`E|${index}|${entry.owner}|${entry.flags ?? 4}|${entry.aces.length}`);
    for (const ace of entry.aces) lines.push(`A|${index}|${ace}`);
  });
  lines.push("END");
  return lines.join("\n");
}
const allow = (mask: number, sid: string, flags = 0) => `0|${flags}|${mask}|${sid}|False`;
const deny = (mask: number, sid: string) => `1|0|${mask}|${sid}|False`;
const opaqueAce = (objectType = 5) => `${objectType}|X`;

describe("windows owner ACL mixed policies", () => {
  const userRun = (entries: readonly { owner: string; flags?: number; aces: readonly string[] }[],
    user = USER_SID, tokenOwner = USER_SID, elevated = false) => aclRun(user, tokenOwner, elevated, entries);

  test("a foreign read-only grantee passes write-private but an untrusted writer refuses", () => {
    const entries: WindowsAclEntry[] = [{ path: "C:\\cfg", directory: true, policy: "write-private" }];
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), allow(READ_ONLY_MASK, FOREIGN_SID)] }]), entries)).toBe(true);
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), allow(READ_ONLY_MASK | WRITE_BITS, FOREIGN_SID)] }]), entries)).toBe(false);
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), allow(CREATE_ONLY_MASK, FOREIGN_SID)] }]), entries)).toBe(false);
    // Kernel-equivalent owners are trusted independent of this token's elevation
    // state: a SYSTEM-owned entry granting only SYSTEM is confined either way.
    expect(windowsEntriesAclMatches(userRun([{ owner: SYSTEM_SID, aces: [allow(FULL_CONTROL, SYSTEM_SID)] }]), entries)).toBe(true);
    // Regression: an Administrators-owned profile parent must pass under a
    // filtered token exactly as under an elevated one — elevation only gates the
    // strict "private" objects this process hardened itself.
    const adminOwned = [{ owner: ADMIN_SID, aces: [allow(FULL_CONTROL, USER_SID), allow(FULL_CONTROL, ADMIN_SID)] }];
    expect(windowsEntriesAclMatches(userRun(adminOwned, USER_SID, USER_SID, false), entries)).toBe(true);
    expect(windowsEntriesAclMatches(userRun(adminOwned, USER_SID, ADMIN_SID, true), entries)).toBe(true);
    // A trusted owner does not launder an untrusted writer.
    const adminOwnedLeaky = [{ owner: ADMIN_SID, aces: [allow(FULL_CONTROL, USER_SID), allow(READ_ONLY_MASK | WRITE_BITS, FOREIGN_SID)] }];
    expect(windowsEntriesAclMatches(userRun(adminOwnedLeaky, USER_SID, USER_SID, false), entries)).toBe(false);
  });

  test("trusted ancestry accepts kernel-owned read-sharing and admin-owned create-only ancestors", () => {
    const entries: WindowsAclEntry[] = [{ path: "C:\\", directory: true, policy: "trusted-ancestry" }];
    for (const owner of [SYSTEM_SID, ADMIN_SID, TRUSTED_INSTALLER_SID]) {
      expect(windowsEntriesAclMatches(userRun([{ owner, aces: [allow(READ_ONLY_MASK, FOREIGN_SID)] }]), entries)).toBe(true);
    }
    // The stock C:\\ shape: a trusted owner may share create-only rights broadly.
    expect(windowsEntriesAclMatches(userRun([{ owner: ADMIN_SID, aces: [allow(READ_ONLY_MASK | CREATE_ONLY_MASK, FOREIGN_SID)] }]), entries)).toBe(true);
    // A user-owned ancestor may not share create rights, and nobody may share delete/write.
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(CREATE_ONLY_MASK, FOREIGN_SID)] }]), entries)).toBe(false);
    expect(windowsEntriesAclMatches(userRun([{ owner: ADMIN_SID, aces: [allow(READ_ONLY_MASK | CREATE_ONLY_MASK | 0x10000, FOREIGN_SID)] }]), entries)).toBe(false);
    expect(windowsEntriesAclMatches(userRun([{ owner: FOREIGN_SID, aces: [allow(FULL_CONTROL, USER_SID)] }]), entries)).toBe(false);
  });

  test("confined policies tolerate deny ACEs but refuse callback, opaque and NULL-DACL output", () => {
    const entries: WindowsAclEntry[] = [{ path: "C:\\cfg", directory: true, policy: "write-private" }];
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), deny(FULL_CONTROL, FOREIGN_SID)] }]), entries)).toBe(true);
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), "9|0|2032127|S-1-5-11|True"] }]), entries)).toBe(false);
    expect(windowsEntriesAclMatches(userRun([{ owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID), opaqueAce()] }]), entries)).toBe(false);
    // NULL DACL: count -1 grants Everyone full access; never acceptable anywhere.
    const nullDacl = [`U|${USER_SID}|${USER_SID}|False`, `E|0|${USER_SID}|4|-1`, "END"].join("\n");
    expect(windowsEntriesAclMatches(nullDacl, entries)).toBe(false);
  });

  test("a mixed batch evaluates ancestry, parent and store policies in one protocol run", () => {
    const entries: WindowsAclEntry[] = [
      { path: "C:\\", directory: true, policy: "trusted-ancestry" },
      { path: "C:\\parent", directory: true, policy: "write-private" },
      { path: "C:\\parent\\ocx\\codex-cli-update-jobs", directory: true },
    ];
    const good = userRun([
      { owner: ADMIN_SID, aces: [allow(READ_ONLY_MASK | CREATE_ONLY_MASK, FOREIGN_SID)] },
      { owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID)] },
      { owner: USER_SID, flags: 4100, aces: [`0|3|${FULL_CONTROL}|${USER_SID}|False`] },
    ]);
    expect(windowsEntriesAclMatches(good, entries)).toBe(true);
    // The private leaf still requires the hardened shape; a relaxed leaf refuses the batch.
    const weakLeaf = userRun([
      { owner: ADMIN_SID, aces: [allow(READ_ONLY_MASK | CREATE_ONLY_MASK, FOREIGN_SID)] },
      { owner: USER_SID, aces: [allow(FULL_CONTROL, USER_SID)] },
      { owner: USER_SID, flags: 4100, aces: [`0|3|${FULL_CONTROL}|${USER_SID}|False`, `0|3|${READ_ONLY_MASK}|${FOREIGN_SID}|False`] },
    ]);
    expect(windowsEntriesAclMatches(weakLeaf, entries)).toBe(false);
  });
});

describe("Windows CLI update job store backend", () => {
  const result: CodexCliApplyResult = { outcome: "applied", reason: "verified_target", planId: "a".repeat(32),
    installedVersion: "1.0.0", targetVersion: "1.1.0", installerExitCode: 0, leaseRetained: false,
    verificationPid: null, cleanupErrors: [] };
  const fixtures: string[] = [];
  const envStack: (string | undefined)[] = [];
  const fixtureOwners = new Map<string, number>();
  function holdFixture(root: string): () => void {
    fixtureOwners.set(root, (fixtureOwners.get(root) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const count = fixtureOwners.get(root)! - 1;
      if (count) fixtureOwners.set(root, count); else fixtureOwners.delete(root);
    };
  }

  afterEach(() => {
    setWindowsOwnerAclAsyncRunnerForTests(null);
    while (envStack.length) {
      const previous = envStack.pop()!;
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    }
    // A timeout does not cancel an async store operation or close its Worker.
    // Keep exact roots queued until both owners have actually completed.
    for (const root of fixtures.splice(0)) {
      if (fixtureOwners.has(root)) { fixtures.push(root); continue; }
      rmSync(root, { recursive: true, force: true });
    }
  });

  const winOnly = process.platform === "win32" && process.arch === "x64";
  // The backend verifies ancestry instead of trusting a well-known root, so the
  // fixture must sit under ancestors that actually pass: %TEMP% carries a foreign
  // full-control grantee here and an automatic mkdir anywhere inherits foreign
  // write. One hardened root under the volume root gives a clean write-private
  // parent with a single trusted ancestor — the same hardening the store applies
  // to directories it creates itself.
  async function fixture(prefix: string, onCreated?: (root: string) => void): Promise<{ outer: string; configDir: string }> {
    const outer = mkdtempSync("C:\\" + prefix);
    onCreated?.(outer);
    fixtures.push(outer);
    await hardenSecretDirAsync(outer, { required: true });
    return { outer, configDir: join(outer, "ocx") };
  }
  async function withOwnedFixture(prefix: string,
    run: (input: { outer: string; configDir: string }) => Promise<void>): Promise<void> {
    let releaseBase: (() => void) | undefined;
    try {
      // Acquire before fixture()'s first await, including ACL hardening and admission.
      const input = await fixture(prefix, root => { releaseBase = holdFixture(root); });
      await run(input);
    } finally { releaseBase?.(); }
  }
  function useHome(configDir: string): void {
    envStack.push(process.env.OPENCODEX_HOME);
    process.env.OPENCODEX_HOME = configDir;
  }
  function managementCtx(req: Request): ManagementContext {
    return { req, url: new URL(req.url),
      config: { port: 10100, providers: {} } as OcxConfig, deps: {}, version: "test",
      principal: "gui-session", trustedLoopbackIngress: true, guiSessionIssuance: "loopback",
      convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
      syncClaudeAgentDefsBestEffort: async () => {} };
  }

  test.skipIf(!winOnly)("private-store admission and status fence one production Worker completion", () => withOwnedFixture("ocx-winjob-worker-", async ({ outer, configDir }) => {
    useHome(configDir);
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-worker-once-01", planId: result.planId, confirmed: true, configDir });
    expect(accepted.kind).toBe("accepted");
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let engineCalls = 0, workerStarts = 0;
    const releaseStore = holdFixture(outer);
    const pending = runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, async () => {
      engineCalls++; enter(); await gate;
      return runCodexCliUpdateApplyInWorker(result.planId, {
        jobId: accepted.job.jobId, snapshot: null,
        env: { OPENCODEX_HOME: configDir, CODEX_HOME: join(outer, "codex") },
        spawnWorkerFn: url => {
          workerStarts++;
          const worker = new Worker(url, { type: "module" }), releaseWorker = holdFixture(outer);
          worker.addEventListener("close", releaseWorker, { once: true });
          return worker;
        },
      });
    }, configDir).finally(releaseStore);
    void pending.catch(() => {});
    try {
      await Promise.race([entered, pending.then(() => { throw new Error("store callback did not start"); })]);
      expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "running", ownerState: "active" });
      expect(await admitCodexCliUpdateJob({ requestId: "win-worker-once-01", planId: result.planId, confirmed: true, configDir }))
        .toMatchObject({ kind: "duplicate", job: { jobId: accepted.job.jobId, status: "running" } });
      // A stale generation cannot publish a fabricated successful completion.
      expect(await finishCodexCliUpdateJob(accepted.job.jobId, crypto.randomUUID(), 1, result, configDir))
        .toMatchObject({ status: "running", outcome: null });
      const status = await handleCodexCliUpdateRoutes(managementCtx(
        new Request(`http://localhost/api/codex/cli-update/jobs/${accepted.job.jobId}`)));
      expect(status?.status).toBe(200);
      expect(await status?.json()).toMatchObject({ jobId: accepted.job.jobId, status: "running", ownerState: "active" });
      const lines: string[] = [];
      const log = spyOn(console, "log").mockImplementation((...values: unknown[]) => lines.push(values.map(String).join(" ")));
      try {
        expect(await handleCodexCliUpdateCommand(["status", accepted.job.jobId, "--json"])).toBe(0);
        expect(JSON.parse(lines[0]!)).toMatchObject({ jobId: accepted.job.jobId, status: "running" });
      } finally { log.mockRestore(); }
    } finally { release(); await pending.catch(() => {}); }
    expect(await pending).toMatchObject({ status: "refused", outcome: "refused", reason: "windows_apply_disabled", ownerState: "finished" });
    // The real production entry refuses before inspection/lease/installer on Windows.
    expect(engineCalls).toBe(1); expect(workerStarts).toBe(1);
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "refused", ownerState: "finished" });
    const ledger = JSON.parse(readFileSync(join(configDir, "codex-cli-update-jobs", "jobs.json"), "utf8")) as { jobs: { revision: number }[] };
    expect(ledger.jobs[0]!.revision).toBe(2);
  }), 60_000);

  test.skipIf(!winOnly)("private-store completion preserves an unknown live Worker without replaying its engine", () => withOwnedFixture("ocx-winjob-worker-unknown-", async ({ outer, configDir }) => {
    useHome(configDir);
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-worker-unknown-01", planId: result.planId, confirmed: true, configDir });
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * FIXTURE_CONTROL_WORDS));
    const worker = new Worker(new URL("../helpers/cli-update-fixture-worker.ts", import.meta.url), { type: "module" });
    const terminate = spyOn(worker, "terminate");
    const releaseWorker = holdFixture(outer);
    let closed = false;
    const joined = new Promise<void>(resolve => worker.addEventListener("close", () => {
      closed = true; releaseWorker(); resolve();
    }, { once: true }));
    worker.postMessage({ type: "fixture-config", control: control.buffer, reply: "ambiguous", block: "after-reply" });
    const initial = codexCliUpdateUnjoinedWorkerCount();
    let engineCalls = 0, workerStarts = 0;
    const releaseStore = holdFixture(outer);
    const pending = runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, () => {
      engineCalls++;
      return runCodexCliUpdateApplyInWorker(result.planId, { jobId: accepted.job.jobId, snapshot: null,
        closeGraceMs: 10, spawnWorkerFn: () => { workerStarts++; return worker; } });
    }, configDir).finally(releaseStore);
    void pending.catch(() => {});
    try {
      expect(await pending).toMatchObject({ status: "ambiguous", reason: "job_result_unknown", ownerState: "finished",
        childState: "unknown", leaseState: "unknown", lifetimeUncertain: true });
      expect(closed).toBe(false);
      expect(terminate).not.toHaveBeenCalled();
      expect(codexCliUpdateUnjoinedWorkerCount()).toBe(initial + 1);
      expect(await admitCodexCliUpdateJob({ requestId: "win-worker-unknown-01", planId: result.planId, confirmed: true, configDir }))
        .toMatchObject({ kind: "duplicate", job: { jobId: accepted.job.jobId, status: "ambiguous" } });
      const status = await handleCodexCliUpdateRoutes(managementCtx(
        new Request(`http://localhost/api/codex/cli-update/jobs/${accepted.job.jobId}`)));
      expect(status?.status).toBe(200);
      expect(await status?.json()).toMatchObject({ status: "ambiguous", childState: "unknown", leaseState: "unknown" });
      expect(engineCalls).toBe(1); expect(workerStarts).toBe(1);
    } finally {
      Atomics.store(control, FIXTURE_RELEASE, 1); Atomics.notify(control, FIXTURE_RELEASE);
      // If store admission failed before dispatch, this fixture may still be idle.
      try { worker.postMessage({ type: "fixture-close" }); } catch { /* close still must be observed */ }
      await joined; await pending.catch(() => {});
      terminate.mockRestore();
    }
    expect(codexCliUpdateUnjoinedWorkerCount()).toBe(initial);
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "ambiguous", reason: "job_result_unknown" });
  }), 60_000);

  test.skipIf(!winOnly)("admission dedupes, conflicts, applies and reads back through the real private store", async () => {
    const { configDir } = await fixture("ocx-winjob-admit-");
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-admit-0001", planId: result.planId, confirmed: true, configDir });
    expect(accepted.kind).toBe("accepted");
    const replay = await admitCodexCliUpdateJob({ requestId: "win-admit-0001", planId: result.planId, confirmed: true, configDir });
    expect(replay).toMatchObject({ kind: "duplicate", job: { jobId: accepted.job.jobId } });
    await expect(admitCodexCliUpdateJob({ requestId: "win-admit-0001", planId: "b".repeat(32), confirmed: true, configDir }))
      .rejects.toThrow("idempotency_conflict");
    let runs = 0;
    const terminal = await runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, async () => { runs++; return result; }, configDir);
    expect(terminal).toMatchObject({ status: "applied", outcome: "applied", ownerState: "finished" });
    expect(runs).toBe(1);
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "applied", ownerState: "finished" });
    expect(existsSync(join(configDir, "codex-cli-update-jobs", "jobs.json"))).toBe(true);
    expect(existsSync(join(configDir, "codex-cli-update-jobs", "admission.lock"))).toBe(false);
    expect(JSON.stringify(terminal)).not.toMatch(/ownerPid|generation|payloadHash|requestKey|token|path/i);
  }, 180_000);

  test.skipIf(!winOnly)("a second process dedupes the admitted request key and conflicts on a different payload", async () => {
    const { configDir } = await fixture("ocx-winjob-twoproc-");
    mkdirSync(configDir);
    const modulePath = new URL("../../src/codex/cli-update-job.ts", import.meta.url).href;
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-two-proc-01", planId: result.planId, confirmed: true, configDir });
    const script = `import { admitCodexCliUpdateJob } from ${JSON.stringify(modulePath)};
      const planId = process.argv.at(-1);
      try {
        const admitted = await admitCodexCliUpdateJob({ requestId: "win-two-proc-01", planId, confirmed: true });
        console.log(JSON.stringify({ kind: admitted.kind, jobId: admitted.job.jobId }));
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(3); }`;
    const env = { ...process.env, OPENCODEX_HOME: configDir };
    const duplicate = spawnSync(process.execPath, ["-e", script, result.planId], { encoding: "utf8", timeout: 120_000, env });
    expect(duplicate.error).toBeUndefined();
    expect(duplicate.stderr).toBe("");
    expect(duplicate.status).toBe(0);
    expect(JSON.parse(duplicate.stdout.trim())).toEqual({ kind: "duplicate", jobId: accepted.job.jobId });
    const conflict = spawnSync(process.execPath, ["-e", script, "d".repeat(32)], { encoding: "utf8", timeout: 120_000, env });
    expect(conflict.status).toBe(3);
    expect(conflict.stderr).toContain("idempotency_conflict");
  }, 300_000);

  test.skipIf(!winOnly)("an ACL verification failure refuses before the engine runs", async () => {
    const { configDir } = await fixture("ocx-winjob-aclfail-");
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-acl-fail-01", planId: result.planId, confirmed: true, configDir });
    let runs = 0;
    setWindowsOwnerAclAsyncRunnerForTests(async () => ({ success: false, timedOut: false, stdout: "" }));
    try {
      await expect(runCodexCliUpdateJob(accepted.job.jobId, accepted.generation,
        async () => { runs++; return result; }, configDir)).rejects.toThrow("unsafe_store");
      expect(runs).toBe(0);
    } finally { setWindowsOwnerAclAsyncRunnerForTests(null); }
    // The refused begin left the durable record intact; with this process having
    // released ownership it reads back honestly as an owner-unknown queued record.
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject(
      { status: "ambiguous", ownerState: "unknown", reason: "owner_state_unknown" });
    // A replaced (corrupt) ledger body refuses reads and later admission the same closed way.
    writeFileSync(join(configDir, "codex-cli-update-jobs", "jobs.json"), "not a ledger", "utf8");
    await expect(readCodexCliUpdateJob(accepted.job.jobId, configDir)).rejects.toThrow();
    await expect(admitCodexCliUpdateJob({ requestId: "win-acl-fail-02", planId: result.planId, confirmed: true, configDir })).rejects.toThrow();
  }, 180_000);

  test.skipIf(!winOnly)("a transient persistence failure retries the completed revision without rerunning the engine", async () => {
    const { configDir } = await fixture("ocx-winjob-retry-");
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-retry-0001", planId: result.planId, confirmed: true, configDir });
    const nativeSync = fs.fsyncSync;
    let calls = 0, runs = 0;
    let sync: ReturnType<typeof spyOn> | undefined;
    try {
      const terminal = await runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, async () => {
        runs++;
        // Installed here so call numbering starts at completion: call 1 is the
        // finish admission-lock owner fsync, call 2 the ledger temp-body fsync —
        // a transient failure there retries the same revision, never the engine.
        sync = spyOn(fs, "fsyncSync").mockImplementation(fd => {
          if (++calls === 2) throw Object.assign(new Error("injected transient sync failure"), { code: "EBUSY" });
          return nativeSync(fd);
        });
        return result;
      }, configDir);
      expect(terminal).toMatchObject({ status: "applied", reason: "verified_target" });
    } finally { sync?.mockRestore(); }
    expect(runs).toBe(1);
    expect(calls).toBeGreaterThan(2);
    expect(await readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ outcome: "applied" });
    const ledger = JSON.parse(readFileSync(join(configDir, "codex-cli-update-jobs", "jobs.json"), "utf8")) as { jobs: { revision: number }[] };
    expect(ledger.jobs[0]!.revision).toBe(2);
  }, 180_000);

  test.skipIf(!winOnly)("a restarted reader reports an unfinished owner unknown without claiming it stopped",
    () => withOwnedFixture("ocx-winjob-restart-", async ({ outer, configDir }) => {
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-restart-001", planId: result.planId, confirmed: true, configDir });
    // The gate resolve exists before the engine callback can be entered: whenever
    // finally runs, release() settles the gate even if the engine starts late or never.
    let release!: () => void;
    const engineGate = new Promise<CodexCliApplyResult>(resolve => { release = () => resolve(result); });
    const releaseStore = holdFixture(outer);
    const pending = runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, () => engineGate, configDir).finally(releaseStore);
    // A status probe may see a transient unsafe_store (e.g. a killed ACL-read child
    // racing the running phase); the poll retries rather than asserting transport.
    const probe = async () => {
      try { return await readCodexCliUpdateJob(accepted.job.jobId, configDir); }
      catch { return null; }
    };
    try {
      // Bounded wall-time poll that also watches pending's own settlement: a failed
      // begin resolves early with the queued DTO, so the job never reads "running".
      let settled: Awaited<typeof pending> | undefined;
      void pending.then(value => { settled = value; }, () => { settled = null; });
      const deadline = Date.now() + 120_000;
      let seen: Awaited<ReturnType<typeof probe>> = null;
      while (settled === undefined && Date.now() < deadline) {
        seen = await probe();
        if (seen?.status === "running") break;
        await Bun.sleep(10);
      }
      expect(settled !== undefined ? settled : seen).toMatchObject({ status: "running", ownerState: "active" });
      const modulePath = new URL("../../src/codex/cli-update-job.ts", import.meta.url).href;
      const script = `import { readCodexCliUpdateJob } from ${JSON.stringify(modulePath)};
        console.log(JSON.stringify(await readCodexCliUpdateJob(${JSON.stringify(accepted.job.jobId)})));`;
      const releaseChild = holdFixture(outer);
      try {
        const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 120_000,
          env: { ...process.env, OPENCODEX_HOME: configDir } });
        expect({ error: child.error ?? null, status: child.status, signal: child.signal,
          stdout: child.stdout?.trim() ?? null, stderr: child.stderr?.trim() ?? null })
          .toMatchObject({ error: null, status: 0 });
        expect(JSON.parse(child.stdout.trim())).toMatchObject({ status: "ambiguous", outcome: "ambiguous",
          ownerState: "unknown", lifetimeUncertain: true, reason: "owner_state_unknown" });
      } finally { releaseChild(); }
    } finally {
      release();
      await pending.catch(() => undefined);
    }
    expect(await pending).toMatchObject({ status: "applied", ownerState: "finished" });
  }), 300_000);

  test.skipIf(!winOnly)("HTTP apply advertises retry on a leftover lock and status reads the same durable record", async () => {
    const { configDir } = await fixture("ocx-winjob-http-");
    const accepted = await admitCodexCliUpdateJob({ requestId: "win-http-00001", planId: result.planId, confirmed: true, configDir });
    useHome(configDir);
    // Crash-shaped residue: an admission.lock the backend never wrote keeps later admission busy.
    mkdirSync(join(configDir, "codex-cli-update-jobs", "admission.lock"));
    const applyReq = () => new Request("http://localhost/api/codex/cli-update/apply", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "win-http-other-1", planId: "e".repeat(32), confirmed: true }) });
    const busy = await handleCodexCliUpdateRoutes(managementCtx(applyReq()));
    expect(busy?.status).toBe(503);
    expect(await busy?.json()).toEqual({ error: "job_store_busy" });
    expect(busy?.headers.get("Retry-After")).toBe("1");
    rmSync(join(configDir, "codex-cli-update-jobs", "admission.lock"), { recursive: true });
    const status = await handleCodexCliUpdateRoutes(managementCtx(
      new Request(`http://localhost/api/codex/cli-update/jobs/${accepted.job.jobId}`)));
    expect(status?.status).toBe(200);
    expect(await status?.json()).toMatchObject({ jobId: accepted.job.jobId, status: "queued", ownerState: "active" });
    const logs: string[] = [];
    const oldLog = console.log;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(["status", accepted.job.jobId, "--json"])).toBe(0);
    } finally { console.log = oldLog; }
    expect(JSON.parse(logs[0]!)).toMatchObject({ jobId: accepted.job.jobId, status: "queued" });
  }, 180_000);

  test.skipIf(!winOnly)("a config path that is a file refuses before any write", async () => {
    const { configDir } = await fixture("ocx-winjob-filecfg-");
    writeFileSync(configDir, "not a directory", "utf8");
    let runs = 0;
    await expect(admitCodexCliUpdateJob({ requestId: "win-file-cfg-01", planId: result.planId, confirmed: true, configDir })).rejects.toThrow();
    await expect(runCodexCliUpdateJob("12345678-1234-1234-1234-123456789012", "12345678-1234-1234-1234-123456789012",
      async () => { runs++; return result; }, configDir)).rejects.toThrow();
    expect(runs).toBe(0);
  }, 60_000);
});
