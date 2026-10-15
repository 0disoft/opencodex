import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import { resolveServiceListenPort } from "../../src/service/definition";
import { installedServiceListenPort } from "../../src/service/health";
import {
  expectedLaunchdCommand,
  launchdListenPort,
  probeLaunchdLoadState,
  startLaunchd,
} from "../../src/service/launchd";
import { plistPath } from "../../src/service/state";
import { systemdListenPort, unitPath } from "../../src/service/systemd";

const foreignPort = 18221;
const configuredPort = 18222;
const plistPort = 18223;
const previousHome = process.env.OPENCODEX_HOME;
const previousBakedPort = process.env.OCX_BAKE_PORT;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), "ocx-launchd-port-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env.OCX_BAKE_PORT;
  fs.writeFileSync(join(home, "config.json"), JSON.stringify({ ...getDefaultConfig(), port: configuredPort }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousBakedPort === undefined) delete process.env.OCX_BAKE_PORT;
  else process.env.OCX_BAKE_PORT = previousBakedPort;
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Synthetic reads at the production artifact paths, never real service files. Using
 * HOME alone cannot isolate these paths on every platform. The missing-plist case
 * also proves the old generic fallback selects the foreign unit, so restoring it in
 * either caller makes the regression fail. Manager calls use the existing seams.
 */
function withArtifacts(plist: string | null, body: () => void): void {
  const launchdPath = plistPath();
  const systemdPath = unitPath();
  const original = fs.readFileSync;
  const read = spyOn(fs, "readFileSync").mockImplementation(((path: any, ...args: any[]) => {
    if (path === launchdPath) {
      if (plist === null) throw Object.assign(new Error("missing fixture plist"), { code: "ENOENT" });
      return plist;
    }
    if (path === systemdPath) return `ExecStart=/fixture/ocx start --port ${foreignPort}\n`;
    return original(path, ...args);
  }) as typeof fs.readFileSync);
  try {
    expect(systemdListenPort()).toBe(foreignPort);
    expect(resolveServiceListenPort()).toBe(configuredPort);
    expect(launchdListenPort()).toBe(plist === null ? null : plistPort);
    expect(installedServiceListenPort()).toBe(plist === null ? foreignPort : plistPort);
    body();
  } finally {
    read.mockRestore();
  }
}

for (const fixture of [
  { name: "missing plist ignores the foreign systemd port", plist: null, expectedPort: configuredPort },
  { name: "installed plist takes precedence over config and foreign systemd", plist: `<string>exec '/fixture/ocx' start --port ${plistPort}</string>`, expectedPort: plistPort },
]) {
  describe(fixture.name, () => {
    test("the default load-state probe expects the launchd port", () => {
      withArtifacts(fixture.plist, () => {
        const expected = expectedLaunchdCommand(fixture.expectedPort);
        expect(expected).toEndWith(`start --port ${fixture.expectedPort}`);
        const calls: string[][] = [];
        const verdict = probeLaunchdLoadState({
          uid: 501,
          launchctl: args => {
            calls.push(args);
            return { ok: true, stdout: expected, stderr: "", status: 0 };
          },
        });
        expect(verdict).toEqual({ state: "loaded-current", domain: "gui/501" });
        expect(calls).toEqual([["print", "gui/501/com.opencodex.proxy"]]);
      });
    });

    test("an already-loaded start checks the launchd port", () => {
      withArtifacts(fixture.plist, () => {
        const commands: string[] = [];
        const calls: string[][] = [];
        startLaunchd({
          launchctl: args => {
            calls.push(args);
            return { ok: false, stdout: "", stderr: "Load failed: 5", status: 5 };
          },
          matches: command => {
            commands.push(command);
            return { loaded: true, matchesPlist: true };
          },
        });
        expect(commands).toEqual([expectedLaunchdCommand(fixture.expectedPort)]);
        expect(commands[0]).toEndWith(`start --port ${fixture.expectedPort}`);
        expect(calls).toEqual([["load", "-w", plistPath()]]);
      });
    });
  });
}
