import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createTempHome } from "../helpers/temp-home";
import { automaticUpdateLauncherSupported, packageOnlyUpdateSucceeded, prepareWorkerUpdateHome } from "../../src/update/job-update-home";
import { join } from "node:path";
import { readUpdateJob, runGuiUpdateWorker } from "../../src/update/job";

test("an old delegated launcher is refused before automatic update starts", async () => {
  const box = createTempHome("ocx-update-home-worker-");
  const priorHome = process.env.HOME;
  process.env.HOME = box.root;
  mkdirSync(box.codexHome, { recursive: true });
  try {
    const events: string[] = [];
    await runGuiUpdateWorker("old-launcher", "latest", false, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer: "npm", updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }),
      launcherSupportsUpdateHomeFn: (launcher, node) => {
        expect(launcher).toMatch(/bin[\\/]ocx\.mjs$/); expect(node).toBeTruthy(); events.push("probe"); return false;
      },
      runCommandFn: () => { events.push("update"); return { status: 0, signal: null }; },
    });
    expect(events).toEqual(["probe"]);
    expect(readUpdateJob("old-launcher")?.status).toBe("failed");
    expect(readUpdateJob("old-launcher")?.error).toContain("guarded recovery protocol");
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    box.remove();
  }
});

test("package-only capability can be verified without home or Bun inspection", () => {
  const box = createTempHome("ocx-update-home-protocol-");
  try {
    mkdirSync(join(box.root, "bin")); mkdirSync(join(box.root, "src", "update"), { recursive: true });
    writeFileSync(join(box.root, "src", "update", "service-home-protocol.json"), JSON.stringify({
      schemaVersion: 1, launcherProtocolVersion: 1, entry: "__update-home-probe",
    }));
    writeFileSync(join(box.root, "src", "update", "service-home-package-only-protocol.json"), JSON.stringify({
      schemaVersion: 1, packageOnlyProtocolVersion: 1, entry: "__update-package-only-probe",
    }));
    const launcher = join(box.root, "bin", "ocx.mjs");
    writeFileSync(launcher, 'console.log(JSON.stringify({schemaVersion:1,packageOnlyProtocolVersion:1}));');
    expect(automaticUpdateLauncherSupported(launcher, process.execPath)).toBe(true);
    writeFileSync(launcher, 'console.log("malformed");');
    expect(automaticUpdateLauncherSupported(launcher, process.execPath)).toBe(false);
  } finally { box.remove(); }
});

for (const installer of ["npm", "bun"] as const) test(`worker ${installer} installs with initial unknown but never restarts`, async () => {
  const box = createTempHome("ocx-update-home-unknown-worker-");
  mkdirSync(box.codexHome, { recursive: true });
  try {
    const events: string[] = [];
    await runGuiUpdateWorker(`unknown-${installer}`, "latest", true, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer, updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }),
      launcherSupportsUpdateHomeFn: () => true,
      serviceHomeAuthorityFn: () => ({ kind: "unknown" }),
      resolveOwnershipFn: () => { throw new Error("restart must not acquire runtime authority"); },
      runCommandFn: (_job, bin, args) => {
        expect(args).toEqual([expect.stringMatching(/bin[\\/]ocx\.mjs$/), "update", "--tag", "latest", "--update-package-only", "--update-worker-result"]);
        expect(bin).toBeTruthy(); events.push("update"); return { status: 0, signal: null };
      },
    });
    expect(events).toEqual(["update"]);
    const job = readUpdateJob(`unknown-${installer}`);
    expect(job).toMatchObject({ status: "succeeded", restarted: false });
    // The persisted command must survive renderSafeCommand: bare node name plus the launcher
    // path placeholder, like the ordinary npm/pnpm worker display — never an ocx literal that
    // would be withheld as an unrecognized shape.
    expect(job?.command).toBe("node <path> update --tag latest --update-package-only");
    expect(JSON.stringify(job?.log)).toContain("ownership could not be verified");
    expect(JSON.stringify(job?.log)).toContain("Restart the proxy manually");
  } finally { box.remove(); }
});

test("a child package-only success vetoes parent restart even when its own home remains matching", async () => {
  const box = createTempHome("ocx-update-home-child-result-");
  mkdirSync(box.codexHome, { recursive: true });
  try {
    let restartChecks = 0;
    await runGuiUpdateWorker("child-package-only", "latest", true, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer: "npm", updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }), launcherSupportsUpdateHomeFn: () => true,
      serviceHomeAuthorityFn: () => ({ kind: "same" }),
      resolveOwnershipFn: () => { restartChecks++; throw new Error("runtime recovery forbidden"); },
      runCommandFn: (_job, _bin, args) => {
        expect(args).toContain("--update-worker-result"); return { status: 75, signal: null };
      },
    });
    expect(restartChecks).toBe(0);
    expect(readUpdateJob("child-package-only")).toMatchObject({ status: "succeeded", restarted: false });
  } finally { box.remove(); }
});

test("a spaced Windows launcher path still yields a recognizable package-only display", () => {
  // renderSafeCommand splits on \s and only accepts bare tool tokens: a raw `C:\Program Files\...`
  // display would withhold on both counts (split path, `node.exe` tool). The persisted display
  // must carry the pre-sanitized `<path>` placeholder while bin/args keep the real spaced path.
  const command = { bin: "placeholder", args: [] as string[], display: "" };
  const reports: string[] = [];
  const policy = prepareWorkerUpdateHome(command, "npm",
    "C:\\Program Files\\OpenCodex\\bin\\ocx.mjs", "node.exe", "latest",
    message => reports.push(message),
    () => ({ kind: "unknown" }),
    () => true);
  expect(policy?.packageOnly).toBe(true);
  expect(command.bin).toBe("node.exe");
  expect(command.args).toEqual([
    "C:\\Program Files\\OpenCodex\\bin\\ocx.mjs", "update", "--tag", "latest",
    "--update-package-only", "--update-worker-result",
  ]);
  expect(command.display).toBe("node <path> update --tag latest --update-package-only");
});

test("a home authority change after install persists the refusal as the job error", async () => {
  const box = createTempHome("ocx-update-home-late-refusal-");
  mkdirSync(box.codexHome, { recursive: true });
  try {
    let flipped = false;
    await runGuiUpdateWorker("late-refusal", "latest", true, {
      checkForUpdateFn: () => ({ currentVersion: "2.7.40", latestVersion: "2.7.41", channel: "latest",
        installer: "npm", updateAvailable: true, canUpdate: true, command: "fixture", releaseNotesUrl: "fixture" }),
      integrityFn: () => ({ ok: true, integrity: "sha512-testfixturevalue000000000" }),
      cachePreflightFn: () => ({ ok: true, reason: "ok" }),
      launcherSupportsUpdateHomeFn: () => true,
      serviceHomeAuthorityFn: () => flipped ? { kind: "foreign", subject: "b".repeat(64) } : { kind: "same" },
      runCommandFn: () => { flipped = true; return { status: 0, signal: null }; },
    });
    const job = readUpdateJob("late-refusal");
    expect(job).toMatchObject({ status: "failed", restarted: false });
    // The refusal text the policy reported must reach `error`, not only `log` — the dashboard
    // surfaces `error` as the failure reason.
    expect(job?.error).toContain("Automatic update restart refused");
    expect(job?.error).toContain("ocx service status");
  } finally { box.remove(); }
});

test("package-only success status is never accepted from an unmarked package manager", () => {
  expect(packageOnlyUpdateSucceeded({ args: ["add", "-g"] }, 75, false)).toBe(false);
  expect(packageOnlyUpdateSucceeded({ args: ["--update-worker-result"] }, 1, true)).toBe(false);
});
