import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createTempHome } from "../helpers/temp-home";
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
