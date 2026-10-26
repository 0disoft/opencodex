import { chmodSync } from "node:fs";
import { resolveTrustedWindowsPowerShellExe } from "../../src/lib/windows-elevation";
import { join } from "node:path";
import { buildCodexLaunchEnv } from "../../src/cli/codex-launcher";
import { codexCredentialDestinationIsTrusted } from "../../src/cli/codex-launch-auth";

// Model a protected, empty machine configuration namespace inside this fixture.
// Every other authority check uses real config/ownership IO. Native probes use production defaults.
export const buildCodexPrivateFixtureLaunchEnv: typeof buildCodexLaunchEnv = (base, deps) => buildCodexLaunchEnv(base, {
  credentialDestination: (home, report) => codexCredentialDestinationIsTrusted(home, join(home, "system-namespace-fixture"), report), ...deps,
});

/** Windows Temp grants Users create rights to descendants; model a private Codex home. */
export function makeCodexLaunchFixturePrivate(path: string): void {
  if (process.platform !== "win32") { chmodSync(path, 0o700); return; }
  const script = String.raw`$ErrorActionPreference='Stop'
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @($user,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($env:OCX_TEST_PRIVATE_DIRECTORY,$acl)`;
  const result = Bun.spawnSync([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, OCX_TEST_PRIVATE_DIRECTORY: path }, stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  if (!result.success) throw new Error("Cannot create private Codex launch fixture");
}
