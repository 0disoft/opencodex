import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireTestRunLock } from "../../scripts/test-run-lock";
import { TEST_RUN_LOCK_RELEASE_WAIT_MS, withTestRunLockGate } from "../../scripts/test-run-lock-gate";
import { helperPath, repoPath } from "../helpers/repo-root";

const startA = "win32:1600000000000";
const reader = (pids: readonly number[]) => new Map(pids.map(pid => [pid, startA]));

async function fixture(body: (f: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>) {
  const f = await makeFixture();
  try { await body(f); }
  finally { await f.finish(); }
}

async function makeFixture() {
  fs.mkdirSync(repoPath(".tmp"), { recursive: true });
  const root = fs.mkdtempSync(repoPath(".tmp", "lock-generation-"));
  const path = join(root, "suite.lock");
  fs.writeFileSync(join(root, "private-fixture"), randomUUID());
  const children: { child: ReturnType<typeof Bun.spawn>; output: Promise<string[]>; startedAt: string }[] = [];
  const crashes = new Set<number>();
  const put = (role: string, suffix: string) => {
    const file = join(root, `${role}.${suffix}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, "true", { flag: "wx" });
  };
  const has = (role: string, suffix: string) => fs.existsSync(join(root, `${role}.${suffix}`));
  const wait = async (role: string, suffix: string) => {
    const end = Date.now() + 20_000;
    while (!has(role, suffix)) {
      if (Date.now() >= end) throw new Error(`Private barrier timed out: ${role}.${suffix}`);
      await Bun.sleep(10);
    }
  };
  const spawn = (role: string, runId = role) => {
    const startedAt = new Date().toISOString();
    const child = Bun.spawn([process.execPath, helperPath("test-run-lock-generation-worker.ts"), root, role, runId], {
      cwd: root, env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    children.push({ child, output, startedAt });
    console.info(JSON.stringify({ lockChildStart: { pid: child.pid, parentPid: process.pid, startedAt, role } }));
    return child;
  };
  const owner = () => JSON.parse(fs.readFileSync(join(path, "owner.json"), "utf8"));
  return { root, path, put, has, wait, spawn, owner, expectCrash(pid: number) { crashes.add(pid); }, async finish() {
    for (const role of ["A", "B", "member", "gate"]) { put(role, "resume"); put(role, "release"); }
    for (const { child, output, startedAt } of children) {
      const timeout = setTimeout(() => child.kill(), 2_000);
      const exitCode = await child.exited;
      clearTimeout(timeout);
      const [stdout, stderr] = await output;
      console.info(JSON.stringify({ lockChildTerminal: { pid: child.pid, startedAt, exitCode, stdout, stderr } }));
      if (crashes.has(child.pid)) expect(exitCode).not.toBe(0);
      else expect(exitCode).toBe(0);
    }
    // Inspect the exact private root separately from removal. No shared lock path
    // or redirect is accepted, and cleanup never uses force.
    expect(root.startsWith(repoPath(".tmp", "lock-generation-"))).toBe(true);
    expect(fs.lstatSync(root).isSymbolicLink()).toBe(false);
    for (const name of fs.readdirSync(root)) expect(fs.lstatSync(join(root, name)).isSymbolicLink()).toBe(false);
    fs.rmSync(root, { recursive: true });
    expect(fs.existsSync(root)).toBe(false);
  } };
}

for (const initializing of [false, true]) {
  test(`generation gate prevents duplicate acquisition during ${initializing ? "initial probe" : "stale verdict"}`, async () => {
    await fixture(async f => {
      if (!initializing) {
        fs.mkdirSync(f.path);
        fs.writeFileSync(join(f.path, "owner.json"), JSON.stringify({ version: 1, runId: "seed", token: "seed",
          pid: process.pid, acquiredAt: new Date().toISOString(), processStart: startA }));
      }
      f.spawn("A");
      await f.wait("A", "blocked");
      const first = fs.existsSync(f.path) ? fs.lstatSync(f.path, { bigint: true }).ino : null;
      f.spawn("B");
      await f.wait("B", "waited");
      if (initializing) await Bun.sleep(10_300); // real grace, no timestamp spoofing
      expect(f.has("B", "acquired")).toBe(false);
      if (initializing) expect(fs.existsSync(f.path)).toBe(false);
      else expect(String(fs.lstatSync(f.path, { bigint: true }).ino)).toBe(String(first));
      f.put("A", "resume");
      await f.wait("A", "acquired");
      expect(f.owner().runId).toBe("A");
      expect(f.has("B", "acquired")).toBe(false);
      f.put("A", "release");
      await f.wait("A", "terminal");
      await f.wait("B", "acquired");
      expect(f.owner().runId).toBe("B");
    });
  }, 40_000);
}

test("generation gate is recovered after its exact holder process dies", async () => {
  const f = await makeFixture();
  try {
    const holder = f.spawn("gate");
    await f.wait("gate", "blocked");
    const gateIdentity = fs.lstatSync(`${f.path}.gate.sqlite`, { bigint: true }).ino;
    f.spawn("B");
    await f.wait("B", "waited");
    expect(f.has("B", "acquired")).toBe(false);
    f.expectCrash(holder.pid);
    holder.kill();
    await holder.exited;
    // The intentional crash's terminal is checked here, separately from clean workers.
    await f.wait("B", "acquired");
    expect(f.owner().runId).toBe("B");
    expect(fs.lstatSync(`${f.path}.gate.sqlite`, { bigint: true }).ino).toBe(gateIdentity);
  } finally { await f.finish(); }
}, 30_000);

test("member registration and obsolete owner release preserve generation ownership", async () => {
  await fixture(async f => {
    const owner = await acquireTestRunLock({ runId: "held", lockPath: f.path, env: {},
      processStartBatch: pids => new Map(pids.map(pid => [pid, null])) });
    f.spawn("member", "held");
    await f.wait("member", "blocked");
    let waits = 0;
    await expect(acquireTestRunLock({ runId: "other", lockPath: f.path, env: {}, pollMs: 5, maxWaitMs: 80,
      onWait() { waits++; }, processStartBatch: reader })).rejects.toThrow("timed out");
    expect(waits).toBe(1);
    f.put("member", "resume");
    await f.wait("member", "acquired");
    expect(fs.readdirSync(join(f.path, "members")).length).toBe(1);
    owner.release();
    const next = await acquireTestRunLock({ runId: "next", lockPath: f.path, env: {}, processStartBatch: reader });
    owner.release();
    expect(f.owner().token).toBe(next.owner!.token);
    next.release();
  });
}, 30_000);

test("busy owner release is bounded and preserves the current generation", async () => {
  await fixture(async f => {
    const owner = await acquireTestRunLock({ runId: "held", lockPath: f.path, env: {}, processStartBatch: reader });
    f.spawn("gate");
    await f.wait("gate", "blocked");
    const started = Date.now();
    expect(() => owner.release()).toThrow("generation gate during release");
    expect(Date.now() - started).toBeGreaterThanOrEqual(TEST_RUN_LOCK_RELEASE_WAIT_MS - 100);
    expect(Date.now() - started).toBeLessThan(TEST_RUN_LOCK_RELEASE_WAIT_MS + 3_000);
    expect(f.owner().token).toBe(owner.owner!.token);
    f.put("gate", "resume");
    await f.wait("gate", "terminal");
    owner.release();
    expect(fs.existsSync(f.path)).toBe(false);
  });
}, 30_000);

test("failed owner publication preserves a foreign owner installed at that path", async () => {
  await fixture(async f => {
    const original = fs.writeFileSync;
    let injected = false;
    const write = spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === join(f.path, "owner.json") && !injected) {
        injected = true;
        original(args[0], JSON.stringify({ version: 1, runId: "foreign", token: "foreign", pid: process.pid,
          acquiredAt: new Date().toISOString() }));
        throw Object.assign(new Error("fixture publication failure"), { code: "EACCES" });
      }
      return original(...args);
    });
    try {
      await expect(acquireTestRunLock({ runId: "new", lockPath: f.path, env: {}, processStartBatch: reader }))
        .rejects.toThrow("fixture publication failure");
    } finally { write.mockRestore(); }
    expect(injected).toBe(true);
    expect(f.owner().runId).toBe("foreign");
  });
});

test("gate rejects redirected, hardlinked and non-file paths without touching targets", async () => {
  await fixture(async f => {
    const target = join(f.root, "target");
    fs.writeFileSync(target, "not a gate");
    const digest = () => createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    const before = digest();
    const gate = `${f.path}.gate.sqlite`;
    fs.linkSync(target, gate);
    expect(() => withTestRunLockGate(f.path, () => {})).toThrow("generation gate");
    expect(digest()).toBe(before);
    fs.unlinkSync(gate);
    fs.mkdirSync(gate);
    expect(() => withTestRunLockGate(f.path, () => {})).toThrow("generation gate");
    fs.rmdirSync(gate);
    // Directory junctions do not require Windows symlink privileges.
    const redirected = join(f.root, "redirected");
    fs.mkdirSync(redirected);
    fs.symlinkSync(redirected, gate, process.platform === "win32" ? "junction" : "dir");
    expect(() => withTestRunLockGate(f.path, () => {})).toThrow("generation gate");
    expect(fs.readdirSync(redirected)).toEqual([]);
    fs.unlinkSync(gate);
    const alias = join(f.root, "parent-alias");
    fs.symlinkSync(redirected, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => withTestRunLockGate(join(alias, "suite.lock"), () => {})).toThrow("generation gate");
    expect(fs.readdirSync(redirected)).toEqual([]);
    fs.unlinkSync(alias);
  });
});

test("corrupt gate I/O never falls back to an ungated owner", async () => {
  await fixture(async f => {
    fs.writeFileSync(`${f.path}.gate.sqlite`, "not a database");
    await expect(acquireTestRunLock({ runId: "blocked", lockPath: f.path, env: {}, processStartBatch: reader }))
      .rejects.toThrow();
    expect(fs.existsSync(f.path)).toBe(false);
  });
});

test("owner metadata I/O failure refuses retirement rather than treating it as missing", async () => {
  await fixture(async f => {
    const owner = await acquireTestRunLock({ runId: "held", lockPath: f.path, env: {}, processStartBatch: reader });
    const original = fs.readFileSync;
    const read = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === join(f.path, "owner.json")) throw Object.assign(new Error("fixture I/O failure"), { code: "EIO" });
      return original(...args);
    }) as typeof fs.readFileSync);
    try {
      await expect(acquireTestRunLock({ runId: "blocked", lockPath: f.path, env: {}, processStartBatch: reader }))
        .rejects.toThrow("fixture I/O failure");
    } finally { read.mockRestore(); }
    expect(f.owner().token).toBe(owner.owner!.token);
    owner.release();
  });
});
