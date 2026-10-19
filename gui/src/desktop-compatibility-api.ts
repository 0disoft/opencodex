export type CertificateState = "missing" | "invalid" | "expired" | "renewal-required" | "prepared" | "trusted" | "unknown";
export interface CompatibilityCertificate {
  supported: boolean; state: CertificateState; fingerprint?: string; expiresAt?: number; renewalDue: boolean; busy: string | null;
}
export type CompatibilityActivationLifetime = "trial" | "runtime-session";
export interface CompatibilityRuntime {
  supported: boolean; phase: "off" | "starting" | "running" | "stopping" | "cleanup-required"; running: boolean;
  supportedActivationLifetimes?: CompatibilityActivationLifetime[]; safetyDeadline?: number;
  contextFailure?: "build_unverified" | "native_routing_unverified" | null;
  buildAssessment?: CompatibilityBuildAssessment | null;
  usage?: { mode: "observe" | "apply"; phase: string; outputs: number; appCacheConfirmed: false;
    activationLifetime?: CompatibilityActivationLifetime | null;
    observation?: { jsonSnapshots: number; streamSnapshots: number; validatedActiveStreams: number; lastSnapshotAt: number | null;
      sourceProcessVerified: false; composerRecoveryVerified: false } };
}
export interface CompatibilityBuildAssessment { assessedVersion: string; observedVersion: string | null; verified: boolean; completedAt: number; verificationBasis?: "package-identity" }
export interface CompatibilitySnapshot { certificate: CompatibilityCertificate; runtime: CompatibilityRuntime }
export interface CompatibilityStartupSettings { startOnProxyStart: boolean; revision: string }
export type CompatibilityAction =
  | { target: "certificate"; action: "prepare" | "trust" | "remove-trust" | "renew"; fingerprint?: string }
  | { target: "runtime"; action: "apply"; lifetime?: CompatibilityActivationLifetime }
  | { target: "runtime"; action: "start" | "stop" | "observe" | "launch" };
const ROOT = "/api/codex/desktop-compatibility/";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export class CompatibilityApiError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
async function reply(response: Response): Promise<Record<string, unknown>> {
  let value: unknown; try { value = await response.json(); } catch { throw new CompatibilityApiError("invalid_response"); }
  if (!object(value)) throw new CompatibilityApiError("invalid_response");
  if (!response.ok || value.ok !== true) {
    const candidate = value.error ?? (object(value.activation) ? value.activation.reason : undefined)
      ?? (object(value.launch) ? value.launch.reason : undefined);
    throw new CompatibilityApiError(typeof candidate === "string" && /^[a-z][a-z_-]{0,79}$/.test(candidate) ? candidate : "operation_unconfirmed");
  }
  return value;
}
function parseStartupSettings(value: unknown): CompatibilityStartupSettings {
  if (!object(value) || typeof value.startOnProxyStart !== "boolean" || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)) throw new CompatibilityApiError("invalid_startup_settings");
  return { startOnProxyStart: value.startOnProxyStart, revision: value.revision };
}
export async function readCompatibilityStartupSettings(apiBase: string, signal: AbortSignal): Promise<CompatibilityStartupSettings> {
  return parseStartupSettings((await reply(await fetch(apiBase + ROOT + "settings", { signal }))).settings);
}
export async function saveCompatibilityStartupSettings(apiBase: string, current: CompatibilityStartupSettings, enabled: boolean, signal: AbortSignal): Promise<CompatibilityStartupSettings> {
  return parseStartupSettings((await reply(await fetch(apiBase + ROOT + "settings", { method: "POST", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ startOnProxyStart: enabled, revision: current.revision, confirmed: true }) }))).settings);
}
export function parseCompatibilityCertificate(value: unknown): CompatibilityCertificate {
  if (!object(value) || typeof value.supported !== "boolean" || typeof value.state !== "string" || !["missing", "invalid", "expired", "renewal-required", "prepared", "trusted", "unknown"].includes(value.state)
    || !(value.busy === null || typeof value.busy === "string" && ["prepare", "trust", "remove-trust", "renew"].includes(value.busy))) throw new CompatibilityApiError("invalid_certificate_status");
  if (value.fingerprint !== undefined && (typeof value.fingerprint !== "string" || !/^[A-F0-9]{64}$/.test(value.fingerprint))) throw new CompatibilityApiError("invalid_certificate_status");
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || Math.abs(value.expiresAt) > 8.64e15)) throw new CompatibilityApiError("invalid_certificate_status");
  return { supported: value.supported, state: value.state as CertificateState, busy: value.busy,
    ...(value.fingerprint === undefined ? {} : { fingerprint: value.fingerprint as string }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as number }), renewalDue: value.renewalDue === true };
}
export function parseCompatibilityRuntime(value: unknown): CompatibilityRuntime {
  if (!object(value) || typeof value.supported !== "boolean" || typeof value.running !== "boolean"
    || typeof value.phase !== "string" || !["off", "starting", "running", "stopping", "cleanup-required"].includes(value.phase)
    || value.phase === "running" && !value.running || (value.phase === "off" || value.phase === "starting") && value.running) throw new CompatibilityApiError("invalid_runtime_status");
  const runtime: CompatibilityRuntime = { supported: value.supported, running: value.running, phase: value.phase as CompatibilityRuntime["phase"] };
  if (value.supportedActivationLifetimes !== undefined) {
    if (!Array.isArray(value.supportedActivationLifetimes) || value.supportedActivationLifetimes.length > 2
      || new Set(value.supportedActivationLifetimes).size !== value.supportedActivationLifetimes.length
      || value.supportedActivationLifetimes.some(lifetime => lifetime !== "trial" && lifetime !== "runtime-session")) throw new CompatibilityApiError("invalid_runtime_status");
    runtime.supportedActivationLifetimes = [...value.supportedActivationLifetimes] as CompatibilityActivationLifetime[];
  }
  if (value.safetyDeadline !== undefined) {
    if (!Number.isSafeInteger(value.safetyDeadline) || Number(value.safetyDeadline) < 0 || Number(value.safetyDeadline) > 8.64e15) throw new CompatibilityApiError("invalid_runtime_status");
    runtime.safetyDeadline = value.safetyDeadline as number;
  }
  if (value.contextFailure !== undefined) {
    if (value.contextFailure !== null && value.contextFailure !== "build_unverified" && value.contextFailure !== "native_routing_unverified") throw new CompatibilityApiError("invalid_runtime_status");
    runtime.contextFailure = value.contextFailure;
  }
  if (value.buildAssessment !== undefined) {
    if (value.buildAssessment === null) runtime.buildAssessment = null;
    else {
      const assessment = value.buildAssessment;
      const version = (candidate: unknown) => typeof candidate === "string" && /^\d{1,5}(\.\d{1,5}){3}$/.test(candidate);
      if (!object(assessment) || !version(assessment.assessedVersion)
        || !(assessment.observedVersion === null || version(assessment.observedVersion))
        || assessment.verificationBasis !== undefined && assessment.verificationBasis !== "package-identity"
        || typeof assessment.verified !== "boolean"
        || !Number.isSafeInteger(assessment.completedAt) || Number(assessment.completedAt) < 0 || Number(assessment.completedAt) > 8.64e15
        || assessment.verified === true && (assessment.observedVersion === null
          || assessment.verificationBasis === undefined && assessment.observedVersion !== assessment.assessedVersion)) throw new CompatibilityApiError("invalid_runtime_status");
      runtime.buildAssessment = { assessedVersion: assessment.assessedVersion as string,
        observedVersion: assessment.observedVersion === null ? null : assessment.observedVersion as string,
        verified: assessment.verified as boolean, completedAt: assessment.completedAt as number,
        ...(assessment.verificationBasis === undefined ? {} : { verificationBasis: assessment.verificationBasis as "package-identity" }) };
    }
  }
  if (value.usage !== undefined) {
    if (!object(value.usage) || typeof value.usage.mode !== "string" || !["observe", "apply"].includes(value.usage.mode) || typeof value.usage.phase !== "string"
      || !/^[a-z-]{1,80}$/.test(value.usage.phase) || !Number.isSafeInteger(value.usage.outputs) || Number(value.usage.outputs) < 0
      || value.usage.appCacheConfirmed !== false) throw new CompatibilityApiError("invalid_runtime_status");
    runtime.usage = { mode: value.usage.mode as "observe" | "apply", phase: value.usage.phase, outputs: value.usage.outputs as number, appCacheConfirmed: false };
    if (value.usage.activationLifetime !== undefined) {
      if (value.usage.activationLifetime !== null && value.usage.activationLifetime !== "trial" && value.usage.activationLifetime !== "runtime-session") throw new CompatibilityApiError("invalid_runtime_status");
      runtime.usage.activationLifetime = value.usage.activationLifetime;
    }
    if (value.usage.observation !== undefined) {
      const observed = value.usage.observation;
      if (!object(observed) || ![observed.jsonSnapshots, observed.streamSnapshots, observed.validatedActiveStreams].every(n => Number.isSafeInteger(n) && Number(n) >= 0)
        || !(observed.lastSnapshotAt === null || typeof observed.lastSnapshotAt === "number" && Number.isSafeInteger(observed.lastSnapshotAt) && observed.lastSnapshotAt >= 0 && observed.lastSnapshotAt <= 8.64e15)
        || observed.sourceProcessVerified !== false || observed.composerRecoveryVerified !== false) throw new CompatibilityApiError("invalid_runtime_status");
      runtime.usage.observation = { jsonSnapshots: observed.jsonSnapshots as number, streamSnapshots: observed.streamSnapshots as number,
        validatedActiveStreams: observed.validatedActiveStreams as number, lastSnapshotAt: observed.lastSnapshotAt as number | null,
        sourceProcessVerified: false, composerRecoveryVerified: false };
    }
  }
  return runtime;
}
export async function readCompatibilityRuntime(apiBase: string, signal: AbortSignal): Promise<CompatibilityRuntime> {
  return parseCompatibilityRuntime((await reply(await fetch(apiBase + ROOT + "runtime", { signal }))).runtime);
}
export async function readCompatibilityCertificate(apiBase: string, signal: AbortSignal): Promise<CompatibilityCertificate> {
  return parseCompatibilityCertificate((await reply(await fetch(apiBase + ROOT + "certificate", { signal }))).certificate);
}
export async function readCompatibilitySnapshot(apiBase: string, signal: AbortSignal): Promise<CompatibilitySnapshot> {
  const [certificate, runtime] = await Promise.all([
    readCompatibilityCertificate(apiBase, signal),
    readCompatibilityRuntime(apiBase, signal),
  ]);
  return { certificate, runtime };
}
/** Exactly one POST. Network ambiguity is resolved by a later status read, never automatic replay. */
export async function runCompatibilityAction(apiBase: string, action: CompatibilityAction, signal: AbortSignal): Promise<void> {
  if (action.target === "certificate" && action.action !== "prepare" && (!action.fingerprint || !/^[A-F0-9]{64}$/.test(action.fingerprint))) throw new CompatibilityApiError("certificate_fingerprint_required");
  await reply(await fetch(apiBase + ROOT + action.target, { method: "POST", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: action.action, confirmed: true,
      ...(action.target === "certificate" && action.action !== "prepare" ? { fingerprint: action.fingerprint } : {}),
      ...(action.target === "runtime" && action.action === "apply" ? { accountWideConsent: true,
        ...(action.lifetime === undefined ? {} : { lifetime: action.lifetime }) } : {}) }),
  }));
}
