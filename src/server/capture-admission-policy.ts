import type { OcxConfig } from "../types";
import type { CapturedAdmissionPolicy } from "../types/admission-policy";
import type { DataPlaneAdmission } from "./auth-cors";
import { admissionMayUseMeteredComboTargets, intersectAdmissionModelScopes, resolveAdmissionModelScope } from "./admission-model-scope";
import { fallbackDeviceIds } from "../routing/fallback-policy";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function immutableAdmissionPolicy(policy: CapturedAdmissionPolicy): CapturedAdmissionPolicy {
  return freeze(structuredClone(policy));
}

/** Combine already captured inputs without reading mutable caller or host configuration. */
export function intersectAdmissionPolicies(host: CapturedAdmissionPolicy, caller: CapturedAdmissionPolicy): CapturedAdmissionPolicy {
  return immutableAdmissionPolicy({
    modelScope: intersectAdmissionModelScopes(host.modelScope, caller.modelScope)!,
    allowMeteredComboTargets: host.allowMeteredComboTargets && caller.allowMeteredComboTargets,
    meteredRequiresComboOptIn: host.meteredRequiresComboOptIn || caller.meteredRequiresComboOptIn,
    fallbackPolicies: [...host.fallbackPolicies, ...caller.fallbackPolicies],
  });
}

export function captureAdmissionPolicy(
  config: Pick<OcxConfig, "apiKeys" | "hostname" | "fallback">,
  admission?: DataPlaneAdmission,
  modelScope = resolveAdmissionModelScope(config, admission),
): CapturedAdmissionPolicy {
  return immutableAdmissionPolicy({
    modelScope: modelScope ?? { providers: [], models: [] },
    allowMeteredComboTargets: admissionMayUseMeteredComboTargets(config, admission, { allowMeteredTargets: true }),
    meteredRequiresComboOptIn: !admission || admission.kind === "loopback"
      || admission.callerPolicy?.meteredRequiresComboOptIn === true,
    fallbackPolicies: [
      ...(admission?.callerPolicy?.fallbackPolicies ?? []),
      { config: { fallback: config.fallback }, deviceIds: fallbackDeviceIds(config, admission) },
    ],
  });
}

/** Attach constraints without changing the host's transport/principal identity. */
export function inheritAdmissionPolicy(
  admission: DataPlaneAdmission | undefined,
  callerPolicy: CapturedAdmissionPolicy,
): DataPlaneAdmission {
  return Object.freeze({ ...(admission ?? { kind: "loopback", source: "loopback" }), callerPolicy }) as DataPlaneAdmission;
}
