import { previewRouteModel } from "../../router";
import type { OcxConfig } from "../../types";

/** Promote only a short alias whose ordinary route is this exact upstream model. */
export function preferredModelAliasId(
  config: OcxConfig, provider: string, model: string, alias: string,
): string | undefined {
  if (config.preferModelAliasIds !== true) return undefined;
  try {
    // Preview cannot consume a combo's round-robin selection state. A policy/combo,
    // reserved native name or another provider's native id must keep its own meaning.
    const route = previewRouteModel(config, alias);
    return route.routeReason === "model-alias" && route.providerName === provider && route.modelId === model
      ? alias : undefined;
  } catch {
    // An ambiguous alias stays available through the existing qualified public id.
    return undefined;
  }
}
