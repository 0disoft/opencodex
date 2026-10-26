import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";

// Paths are environment data, never interpolated PowerShell source. The token is
// not read until this read-only subprocess and the config checks have succeeded.
const SCRIPT = String.raw`
$ErrorActionPreference='Stop'
try {
  $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trusted=@($user,'S-1-5-18','S-1-5-32-544')
  $installer='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  $sections=[System.Security.AccessControl.AccessControlSections]'Owner,Access'
  $paths=@($env:OCX_CODEX_OWNED_HOME,[System.IO.Path]::Combine($env:OCX_CODEX_OWNED_HOME,'config.toml'))
  $exactOwners=2
  if ($env:OCX_CODEX_NAMESPACE_CHECK -eq '1') {
    $systemDir=$env:OCX_CODEX_NAMESPACE_FIXTURE
    if ([string]::IsNullOrEmpty($systemDir)) {
      $programData=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
      if ([string]::IsNullOrEmpty($programData)) { exit 1 }
      $systemDir=[System.IO.Path]::Combine($programData,'OpenAI','Codex')
    }
    foreach ($file in @('config.toml','requirements.toml','managed_config.toml')) {
      try { $null=[System.IO.File]::GetAttributes([System.IO.Path]::Combine($systemDir,$file)); exit 1 }
      catch [System.IO.FileNotFoundException] { }
      catch [System.IO.DirectoryNotFoundException] { }
    }
    $existing=$systemDir
    while ($true) {
      try { $attributes=[System.IO.File]::GetAttributes($existing); break }
      catch [System.IO.FileNotFoundException] { }
      catch [System.IO.DirectoryNotFoundException] { }
      $existing=[System.IO.Path]::GetDirectoryName($existing)
      if ([string]::IsNullOrEmpty($existing)) { exit 1 }
    }
    if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0) { exit 1 }
    $paths=@($existing)
    $exactOwners=0
  }
  $parent=[System.IO.Directory]::GetParent($paths[0])
  while ($null -ne $parent) { $paths+= $parent.FullName; $parent=$parent.Parent }
  for ($i=0;$i -lt $paths.Count;$i++) {
    $path=$paths[$i]
    if (([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
    if ([System.IO.Directory]::Exists($path)) { $acl=[System.Security.AccessControl.DirectorySecurity]::new($path,$sections) }
    else { $acl=[System.Security.AccessControl.FileSecurity]::new($path,$sections) }
    $raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
    if ($i -lt $exactOwners -and $raw.Owner.Value -ne $user) { exit 1 }
    if ($i -ge $exactOwners -and $trusted -notcontains $raw.Owner.Value -and $raw.Owner.Value -ne $installer) { exit 1 }
    if ($null -eq $raw.DiscretionaryAcl -or ([int]$raw.ControlFlags -band 4) -eq 0) { exit 1 }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback) { exit 1 }
      if (([int]$ace.AceFlags -band 8) -ne 0) { continue }
      if ([int]$ace.AceType -eq 1) { continue }
      if ([int]$ace.AceType -ne 0) { exit 1 }
      $sid=$ace.SecurityIdentifier.Value
      if ($trusted -contains $sid) { continue }
      # TrustedInstaller is an OS authority on ancestors only, never on the two owned entries.
      if ($i -ge $exactOwners -and $sid -eq $installer) { continue }
      # Include generic writes/all, DELETE, WRITE_DAC, WRITE_OWNER, and directory DELETE_CHILD.
      $mask=[int64]$ace.AccessMask -band 4294967295
      $mutation=1343029590
      if ($i -ge 2 -or ($exactOwners -eq 0 -and $i -ge 1)) { $mutation=1343029312 }
      if (($mask -band $mutation) -ne 0) { exit 1 }
    }
  }
  exit 0
} catch { exit 1 }
`;
const ENCODED_SCRIPT = Buffer.from(SCRIPT, "utf16le").toString("base64");

function windowsOwnershipCheck(home: string, namespace: boolean, fixtureDirectory?: string): boolean {
  // Remove case aliases before constructing a Windows environment block. These
  // private protocol inputs must come from this call, never the caller's shell.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:OCX_CODEX_OWNED_HOME|OCX_CODEX_NAMESPACE_CHECK|OCX_CODEX_NAMESPACE_FIXTURE)$/i.test(key)));
  const result = Bun.spawnSync([
    resolveTrustedWindowsPowerShellExe(), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SCRIPT,
  ], { env: { ...inherited, OCX_CODEX_OWNED_HOME: home, OCX_CODEX_NAMESPACE_CHECK: namespace ? "1" : "0",
    OCX_CODEX_NAMESPACE_FIXTURE: fixtureDirectory }, stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 5_000, windowsHide: true });
  return result.success && !result.exitedDueToTimeout;
}

/** A missing system layer is safe only if another user cannot create it later. */
export function codexPosixSystemNamespace(platform: NodeJS.Platform = process.platform): string {
  // Darwin's /etc is a standard root-owned symlink; inspect its physical namespace.
  return platform === "darwin" ? "/private/etc/codex" : "/etc/codex";
}

export function codexLaunchSystemNamespaceIsSafe(fixtureDirectory?: string): boolean {
  try {
    if (process.platform === "win32") return windowsOwnershipCheck("", true, fixtureDirectory);
    let path = fixtureDirectory ?? codexPosixSystemNamespace();
    for (const file of ["config.toml", "requirements.toml", "managed_config.toml"]) {
      try { lstatSync(join(path, file)); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    for (;;) {
      try { lstatSync(path); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
      if (dirname(path) === path) return false;
      path = dirname(path);
    }
    const paths: string[] = [];
    for (;;) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== process.getuid?.() && stat.uid !== 0)
        || ((stat.mode & 0o022) !== 0 && (paths.length === 0 || (stat.mode & 0o1000) === 0))) return false;
      paths.push(path);
      if (dirname(path) === path) break;
      path = dirname(path);
    }
    return process.platform !== "darwin" || macHasNoManagedCodexPreferences(paths);
  } catch { return false; }
}

/** Match Codex's CFPreferencesAppValueIsForced test without reading preference contents. */
export function darwinAclInspectionIsEmpty(validResult: number, entryResult: number, errorNumber: number): boolean {
  // Darwin differs from POSIX: found entry => 0; a valid empty ACL => -1/EINVAL.
  return validResult === 0 && entryResult === -1 && errorNumber === 22;
}

function macHasNoManagedCodexPreferences(paths: readonly string[]): boolean {
  let library: { close(): void } | undefined;
  let aclLibrary: { close(): void } | undefined;
  try {
    const { dlopen, FFIType, ptr, read } = require("bun:ffi") as typeof import("bun:ffi");
    const acl = dlopen("/usr/lib/libSystem.B.dylib", {
      acl_get_file: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
      acl_get_entry: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      acl_valid: { args: [FFIType.ptr], returns: FFIType.i32 },
      acl_free: { args: [FFIType.ptr], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    aclLibrary = acl;
    for (const path of paths) {
      const bytes = Buffer.from(path + "\0"), entry = Buffer.alloc(8);
      const descriptor = acl.symbols.acl_get_file(ptr(bytes), 0x100); // ACL_TYPE_EXTENDED
      if (!descriptor) return false;
      try {
        // Deny all extended ACLs, including unknown ACL semantics; mode bits alone are insufficient.
        const valid = acl.symbols.acl_valid(descriptor);
        if (valid !== 0) return false;
        const found = acl.symbols.acl_get_entry(descriptor, 0, ptr(entry)); // ACL_FIRST_ENTRY
        const errno = acl.symbols.__error();
        if (!errno || !darwinAclInspectionIsEmpty(valid, found, read.i32(errno))) return false;
      } finally { acl.symbols.acl_free(descriptor); }
    }
    const core = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
      CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
      CFPreferencesAppValueIsForced: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    });
    library = core;
    const strings = ["com.openai.codex", "config_toml_base64", "requirements_toml_base64"].map(value => Buffer.from(value + "\0"));
    const refs = strings.map(value => core.symbols.CFStringCreateWithCString(null, ptr(value), 0x08000100));
    try {
      if (refs.some(value => !value)) return false;
      return !core.symbols.CFPreferencesAppValueIsForced(refs[1]!, refs[0]!)
        && !core.symbols.CFPreferencesAppValueIsForced(refs[2]!, refs[0]!);
    } finally { for (const ref of refs) if (ref) core.symbols.CFRelease(ref); }
  } catch { return false; }
  finally { library?.close(); aclLibrary?.close(); }
}

/** Excludes other-user writers; it cannot isolate processes with the same user identity. */
export function codexLaunchHomeIsOwned(home: string): boolean {
  try {
    const directory = lstatSync(home), config = lstatSync(join(home, "config.toml"));
    if (!directory.isDirectory() || directory.isSymbolicLink() || !config.isFile() || config.isSymbolicLink()) return false;
    if (process.platform === "win32") {
      return windowsOwnershipCheck(home, false);
    }
    const uid = process.getuid?.();
    if (uid === undefined || [directory, config].some(stat => stat.uid !== uid || (stat.mode & 0o022) !== 0)) return false;
    const paths = [home, join(home, "config.toml")];
    for (let parent = dirname(home); ; parent = dirname(parent)) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      if (stat.uid !== uid && stat.uid !== 0) return false;
      // Sticky directories (e.g. /tmp) protect entries owned by this user.
      if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) return false;
      paths.push(parent);
      if (dirname(parent) === parent) break;
    }
    return process.platform !== "darwin" || macHasNoManagedCodexPreferences(paths);
  } catch { return false; }
}
