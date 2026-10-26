/** Fixed reasons only: never interpolate configuration, exceptions or credential paths. */
export const CODEX_TOKEN_REFUSALS = {
  args: "arguments are outside the audited allowlist",
  environment: "environment contains a proxy or unaudited credential control",
  home: "Codex home cannot be resolved unambiguously",
  ownership: "Codex home/config ownership or mutation protection could not be verified",
  systemConfig: "machine Codex configuration adds an unaudited system layer",
  systemNamespace: "machine Codex namespace protection could not be verified",
  systemNamespaceWritable: "machine Codex namespace allows other principals to create or replace configuration",
  additionalLayer: "home or system configuration adds an unaudited authentication/managed/requirements layer",
  layerInspection: "additional configuration layers could not be inspected",
  installationConfig: "OpenCodex configuration could not be verified",
  connection: "client connection is unavailable or uses an authless link relay",
  admission: "configured route does not require an admission credential",
  loopback: "configured destination is not an HTTP loopback listener",
  configRead: "Codex configuration could not be read within the inspection limit",
  consumers: "configuration has additional credential consumers",
  configShape: "configuration contains unaudited keys or values",
  systemProxy: "configuration enables an unaudited system proxy transport",
  provider: "configuration selects a profile or a different provider",
  rootUrl: "configuration overrides the managed loopback URL",
  project: "project configuration adds an unaudited layer",
  providerTransport: "provider transport does not match the managed loopback provider",
  inspection: "credential destination inspection failed",
  destination: "credential destination could not be verified",
  credential: "installation service credential is unavailable or invalid",
  collision: "service credential matches a management credential",
} as const;
export type CodexTokenRefusal = keyof typeof CODEX_TOKEN_REFUSALS;
export type CodexTokenRefusalReporter = (reason: CodexTokenRefusal) => void;

// Run only by an administrator in Windows PowerShell 5.1. Create missing
// directories with the protected DACL already installed; also protect existing
// dedicated directories. SYSTEM/Administrators write; Users only read/traverse.
export const CODEX_WINDOWS_NAMESPACE_COMMAND = String.raw`& { $ErrorActionPreference='Stop'; foreach ($rel in @('OpenAI','OpenAI\Codex')) { $p=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) $rel; $acl=[System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)'); if ([System.IO.Directory]::Exists($p)) { if (([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing a reparse point' }; [System.IO.Directory]::SetAccessControl($p,$acl) } else { [System.IO.Directory]::CreateDirectory($p,$acl) | Out-Null } } }`;

export function codexTokenWithheldDiagnostic(reason: CodexTokenRefusal): string {
  const remedy = process.platform === "win32" && reason === "systemNamespaceWritable"
    ? `; default ProgramData creation rights are insufficient even when OpenAI\\Codex is absent. Ask an administrator to review existing directory policy and run in elevated Windows PowerShell 5.1: ${CODEX_WINDOWS_NAMESPACE_COMMAND}`
    : ". Launching without a fresh token.";
  return `OpenCodex: automatic service token withheld; ${CODEX_TOKEN_REFUSALS[reason]}${remedy}`;
}
