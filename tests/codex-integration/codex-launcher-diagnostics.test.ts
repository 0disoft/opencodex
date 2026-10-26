import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexLaunchEnv, type CodexLaunchEnvDeps } from "../../src/cli/codex-launcher";
import { codexCredentialDestinationIsTrusted } from "../../src/cli/codex-launch-auth";
import { CODEX_WINDOWS_NAMESPACE_COMMAND } from "../../src/cli/codex-launch-diagnostics";
import { resolveTrustedWindowsPowerShellExe } from "../../src/lib/windows-elevation";
import { buildProviderTableBlockForTarget } from "../../src/codex/inject/config-toml";
import { standaloneCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { makeCodexLaunchFixturePrivate } from "../helpers/codex-launch-private-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const secret = "ocx_fixture_diagnostic_secret", contents = "fixture-key-file-content-never-log";

function capture(base: Record<string, string | undefined>, deps: CodexLaunchEnvDeps) {
  const notes: string[] = [], original = console.error;
  console.error = (...values: unknown[]) => { notes.push(values.join(" ")); };
  try { return { env: buildCodexLaunchEnv(base, deps), notes }; }
  finally { console.error = original; }
}

function diagnostic(notes: string[], reason: string) {
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("automatic service token withheld; " + reason);
  expect(notes[0]).not.toMatch(/[\r\n]/);
  for (const forbidden of [secret, contents, "service-api-token", "admin-api-token"]) expect(notes[0]).not.toContain(forbidden);
}

describe("Codex credential withholding diagnostics", () => {
  for (const [base, deps, reason] of [
    [{}, { args: ["--oss"] }, "arguments are outside the audited allowlist"],
    [{ HTTPS_PROXY: contents }, {}, "environment contains a proxy or unaudited credential control"],
    [{ CODEX_HOME: "" }, {}, "Codex home cannot be resolved unambiguously"],
  ] as const) test(reason, () => {
    let reads = 0;
    const result = capture(base, { routingKind: "opencodex-local", ...deps, serviceToken: () => { reads++; return secret; } });
    diagnostic(result.notes, reason);
    expect(reads).toBe(0);
    expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
  });

  test("missing and colliding service credentials have distinct safe reasons", () => {
    for (const [token, extra, reason] of [
      [null, {}, "installation service credential is unavailable or invalid"],
      [secret, { OPENCODEX_ADMIN_AUTH_TOKEN: secret }, "service credential matches a management credential"],
    ] as const) {
      const result = capture({ CODEX_HOME: process.cwd(), ...extra }, { credentialDestination: () => true, serviceToken: () => token });
      diagnostic(result.notes, reason);
      expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
    }
  });

  test("explicit credentials and passthrough launches do not warn or read", () => {
    const serviceToken = () => { throw new Error("must not read"); };
    for (const result of [
      capture({ OPENCODEX_API_AUTH_TOKEN: secret }, { args: ["--oss"], serviceToken }),
      capture({}, { routingKind: "native", serviceToken }),
    ]) expect(result.notes).toEqual([]);
  });

  test.skipIf(process.platform !== "win32")("missing or writable Windows namespace explains admin provisioning, which restores admission", () => {
    const root = mkdtempSync(join(process.env.SystemRoot ?? "C:/Windows", "Temp", "ocx-namespace-diagnostic-"));
    makeCodexLaunchFixturePrivate(root);
    const home = join(root, "codex"), ocx = join(root, "ocx"), machine = join(root, "machine");
    for (const path of [home, ocx, machine]) mkdirSync(path);
    const system = join(machine, "OpenAI", "Codex"), prior = process.env.OPENCODEX_HOME, cwd = process.cwd();
    process.env.OPENCODEX_HOME = ocx;
    process.chdir(root);
    const cfg = { port: 12199, hostname: "0.0.0.0" };
    writeFileSync(join(ocx, "config.json"), JSON.stringify(cfg));
    writeFileSync(join(home, "config.toml"), 'model_provider="opencodex"\n' + buildProviderTableBlockForTarget(standaloneCodexRoutingTarget(cfg.port, cfg)));
    const ps = (script: string) => {
      const result = Bun.spawnSync([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop'\n" + script, "utf16le").toString("base64")], {
        env: { ...process.env, OCX_TEST_MACHINE_ROOT: machine, OCX_TEST_NAMESPACE: system }, stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      expect(result.exitCode).toBe(0);
    };
    const grantCreation = String.raw`$p=$env:OCX_TEST_MACHINE_ROOT
$acl=[System.IO.Directory]::GetAccessControl($p)
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::CreateDirectories,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($p,$acl)`;
    let reads = 0;
    const launch = () => capture({ CODEX_HOME: home }, {
      credentialDestination: (path, report) => codexCredentialDestinationIsTrusted(path, system, report),
      serviceToken: () => { reads++; return secret; },
    });
    try {
      ps(grantCreation);
      // Exercise the documented command in scratch only. The fixture user stands
      // in for Administrators so this test also runs without an elevated token.
      const provision = CODEX_WINDOWS_NAMESPACE_COMMAND
        .replace("[Environment]::GetFolderPath('CommonApplicationData')", "$env:OCX_TEST_MACHINE_ROOT")
        .replace("if ([System.IO.Directory]::Exists", String.raw`$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetOwner($user); $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)); if ([System.IO.Directory]::Exists`);
      for (const existing of [false, true]) {
        if (existing) ps(String.raw`[System.IO.Directory]::CreateDirectory($env:OCX_TEST_NAMESPACE) | Out-Null
$p=$env:OCX_TEST_NAMESPACE
$acl=[System.IO.Directory]::GetAccessControl($p)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::CreateFiles,[System.Security.AccessControl.AccessControlType]::Allow))
[System.IO.Directory]::SetAccessControl($p,$acl)`);
        const result = launch();
        diagnostic(result.notes, "machine Codex namespace allows other principals to create or replace configuration");
        expect(result.notes[0]).toContain("default ProgramData creation rights");
        expect(result.notes[0]).toContain("elevated Windows PowerShell 5.1: " + CODEX_WINDOWS_NAMESPACE_COMMAND);
        expect(result.notes[0]).not.toContain(root);
        expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
        expect(reads).toBe(existing ? 1 : 0);
        ps(provision);
        const protectedResult = launch();
        expect(protectedResult.notes).toEqual([]);
        expect(protectedResult.env.OPENCODEX_API_AUTH_TOKEN).toBe(secret);
      }
      expect(reads).toBe(2);
    } finally {
      process.chdir(cwd);
      if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
      removeTreeWithRetry(root);
    }
  });

  test("configuration reasons reach stderr without file contents or credential paths", () => {
    const root = mkdtempSync(join(process.platform === "win32" ? join(process.env.SystemRoot ?? "C:/Windows", "Temp") : tmpdir(), "ocx-diagnostic-"));
    makeCodexLaunchFixturePrivate(root);
    const home = join(root, "codex"), ocx = join(root, "ocx"), system = join(root, "system");
    for (const path of [home, ocx, system]) mkdirSync(path);
    const cfg = { port: 12199, hostname: "0.0.0.0" }, prior = process.env.OPENCODEX_HOME, cwd = process.cwd();
    process.env.OPENCODEX_HOME = ocx;
    process.chdir(root);
    const local = 'model_provider="opencodex"\n' + buildProviderTableBlockForTarget(standaloneCodexRoutingTarget(cfg.port, cfg));
    writeFileSync(join(ocx, "config.json"), JSON.stringify(cfg));
    try {
      const keyFile = join(ocx, "service-api-token");
      const keyRead = (extra = {}) => capture({ CODEX_HOME: home, ...extra }, { credentialDestination: () => true });
      diagnostic(keyRead().notes, "installation service credential is unavailable or invalid");
      writeFileSync(keyFile, contents + "\n" + secret);
      const malformed = keyRead();
      diagnostic(malformed.notes, "installation service credential is unavailable or invalid");
      expect(malformed.notes[0]).not.toContain(keyFile);
      expect(malformed.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
      writeFileSync(keyFile, secret + "\n");
      const collision = keyRead({ OPENCODEX_ADMIN_AUTH_TOKEN: secret });
      diagnostic(collision.notes, "service credential matches a management credential");
      expect(collision.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
      const loaded = keyRead();
      expect(loaded.notes).toEqual([]);
      expect(loaded.env.OPENCODEX_API_AUTH_TOKEN).toBe(secret);
      for (const [config, reason] of [
        [local + '\n[mcp_servers.fixture]\ncommand="' + contents + '"\n', "configuration has additional credential consumers"],
        ['unknown="' + contents + '"\n' + local, "configuration contains unaudited keys or values"],
        [local.replace("127.0.0.1", "capture.invalid"), "provider transport does not match the managed loopback provider"],
        ['broken = "' + contents, "credential destination inspection failed"],
      ]) {
        writeFileSync(join(home, "config.toml"), config!);
        let reads = 0;
        const result = capture({ CODEX_HOME: home }, {
          credentialDestination: (path, report) => codexCredentialDestinationIsTrusted(path, system, report),
          serviceToken: () => { reads++; return secret; },
        });
        diagnostic(result.notes, reason!);
        expect(reads).toBe(0);
        expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
        expect(result.notes[0]).not.toContain(root);
      }
      writeFileSync(join(home, "config.toml"), local);
      // The production namespace is deliberately not modified by this test.
      writeFileSync(join(system, "requirements.toml"), contents);
      const result = capture({ CODEX_HOME: home }, {
        credentialDestination: (path, report) => codexCredentialDestinationIsTrusted(path, system, report),
        serviceToken: () => { throw new Error("must not read"); },
      });
      diagnostic(result.notes, "machine Codex configuration adds an unaudited system layer");
    } finally {
      process.chdir(cwd);
      if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
      removeTreeWithRetry(root);
    }
  });
});
