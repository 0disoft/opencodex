import type { OcxConfig } from "../../types";
import { resolveComboId } from "../../combos";
import { isBareOpenAiFamilyModel } from "../../router";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS, NATIVE_RESERVE_MODEL } from "../../codex/catalog/native-models";
import { callerMatchesObservedMain } from "../../codex/auth-context";
import { MAIN_CODEX_ACCOUNT_ID, type NativeMainRefreshDependencies } from "../../codex/main-account";
import {
  getMainAccountHardLockStatus,
  resolveMainAccountHardLockFallback,
} from "../../codex/main-account-hard-lock";
import { entitledCodexAccountIdsForModel, resolveCodexModelEntitlements } from "../../codex/model-entitlements";
import { codexQuotaScopeForModel } from "../../codex/routing/health-store";
import { getEligiblePoolAccounts } from "../../codex/routing/selection";
import { OPENAI_CODEX_PROVIDER_ID, isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { providerCodexAccountMode } from "../../providers/registry";
import { hasForwardableCodexBearer, type DataPlaneAdmission } from "../auth-cors";

function isConfiguredComboSelector(config: OcxConfig, modelId: string): boolean {
  const comboId = resolveComboId(config, modelId);
  return Boolean(comboId && Object.hasOwn(config.combos ?? {}, comboId));
}

function targetsBlockedCanonicalOpenAi(config: OcxConfig, modelId: string): boolean {
  if (isBareOpenAiFamilyModel(modelId) && !isConfiguredComboSelector(config, modelId)) return true;
  const slash = modelId.indexOf("/");
  if (slash <= 0) return false;
  const providerName = modelId.slice(0, slash);
  const rest = modelId.slice(slash + 1);
  if (providerName !== OPENAI_CODEX_PROVIDER_ID || !isBareOpenAiFamilyModel(rest)) return false;
  const provider = config.providers?.[OPENAI_CODEX_PROVIDER_ID];
  return !provider || isCanonicalOpenAiForwardProvider({
    ...provider,
    ...(provider.authMode === undefined ? { authMode: "forward" as const } : {}),
  });
}

/**
 * What one rewritten request carries so the log can show the model the client asked for
 * while the pipeline routes the fallback. The rewrite happens before combo dispatch reads
 * `model`, so the rest of the pipeline sees an ordinary request for the target selector.
 */
export interface MainHardLockFallbackOverride {
  sourceModel: string;
  targetModel: string;
}

export interface MainHardLockFallbackOptions {
  now?: number;
  headers?: Headers;
  admission?: Pick<DataPlaneAdmission, "source">;
  /** Confirmed account ids for an account-gated model; omitted for ordinary native models. */
  modelEligibleAccountIds?: ReadonlySet<string>;
  signal?: AbortSignal;
  nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
  resolveCodexModelEntitlements?: typeof resolveCodexModelEntitlements;
}

function rawModelOf(body: unknown): { raw: Record<string, unknown>; model: string } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const raw = body as Record<string, unknown>;
  return typeof raw.model === "string" && raw.model.trim().length > 0
    ? { raw, model: raw.model }
    : undefined;
}

function normalizeOptions(nowOrOptions?: number | MainHardLockFallbackOptions): MainHardLockFallbackOptions {
  if (typeof nowOrOptions === "number") return { now: nowOrOptions };
  return nowOrOptions ?? {};
}

/**
 * Does the caller carry a credential that `resolveCallerOwnedMainContext` would admit without
 * consulting the main-account hard lock?
 *
 * - In Direct mode, only an admission bearer (which substitutes stored main) or a caller bearer
 *   matching the observed main identity reaches `assertMainAccountPolicy`. A different healthy
 *   ChatGPT account is admitted on its own token, and a missing bearer fails with 401.
 * - In Pool mode, when no stored Pool account is eligible, a request carrying a forwardable
 *   non-main caller bearer falls through to `resolveCallerOwnedMainContext` and is served by
 *   that caller credential rather than failing on the locked main account.
 */
function callerCredentialBypassesHardLock(
  config: OcxConfig,
  accountMode: "pool" | "direct" | undefined,
  options: MainHardLockFallbackOptions,
): boolean {
  const { headers, admission } = options;
  if (!headers) return false;
  if (admission?.source === "bearer") return false;
  if (accountMode === "direct") {
    return !callerMatchesObservedMain(headers);
  }
  return hasForwardableCodexBearer(headers, config) && !callerMatchesObservedMain(headers);
}

/**
 * Extended main-account hard-lock settings: when the lock blocks and no Codex account can
 * serve the request, rewrite it to the configured fallback model instead of letting the
 * dispatch refuse.
 *
 * Every guard bounds the rewrite to exactly the traffic the lock would otherwise fail, so
 * the setting can never widen what the lock protects:
 *
 * - The lock must be enabled AND reading `blocked` right now — `ready`, `unknown` and the
 *   explicit opt-out all admit, and the release is this same observation, so the reroute
 *   ends on its own the moment the blocking windows drop below their thresholds.
 * - `getEligiblePoolAccounts` is the selection choke point the dispatch itself consults,
 *   so "the pool can serve it" is one shared answer, not a second opinion: a usable pool
 *   account (or any eligible account) keeps the request on Codex, and a pool drained to
 *   empty is what makes the fallback the request's only way through. The main account is
 *   already excluded there while blocked.
 * - Only bare Codex-native selectors qualify. Provider-qualified rows, combos, account
 *   namespaces and policy routes name their own destination on purpose; rewriting those
 *   would override an explicit choice, so they keep the lock's refusal.
 * - A Codex-native fallback target is refused outright: rerouting gpt-* to gpt-* would
 *   re-enter the same refusal, and the honest behavior is the refusal, not a loop.
 * - Luna Reserve keeps its own admission policy (`assertReserveAdmission`); its helper
 *   traffic is not operator chat and must not silently change models.
 */
export function applyMainHardLockFallbackOverride(
  body: unknown,
  config: OcxConfig,
  nowOrOptions?: number | MainHardLockFallbackOptions,
): MainHardLockFallbackOverride | null {
  const options = normalizeOptions(nowOrOptions);
  const now = options.now ?? Date.now();
  const parsed = rawModelOf(body);
  if (!parsed) return null;
  const fallback = resolveMainAccountHardLockFallback(config);
  if (!fallback) return null;
  if (targetsBlockedCanonicalOpenAi(config, fallback.model)) return null;
  if (!isBareOpenAiFamilyModel(parsed.model)
    || parsed.model === NATIVE_RESERVE_MODEL
    || isConfiguredComboSelector(config, parsed.model)) return null;
  if (getMainAccountHardLockStatus(config, now).state !== "blocked") return null;
  const accountMode = providerCodexAccountMode(
    OPENAI_CODEX_PROVIDER_ID,
    config.providers?.[OPENAI_CODEX_PROVIDER_ID],
  );
  if (callerCredentialBypassesHardLock(config, accountMode, options)) return null;
  const selectionOptions = options.modelEligibleAccountIds !== undefined
    ? { modelEligibleAccountIds: options.modelEligibleAccountIds }
    : undefined;
  if (accountMode !== "direct"
    && getEligiblePoolAccounts(
      config,
      undefined,
      now,
      codexQuotaScopeForModel(parsed.model),
      selectionOptions,
    ).length > 0) {
    return null;
  }

  parsed.raw.model = fallback.model;
  if (fallback.reasoningEffort !== undefined) {
    const reasoning = parsed.raw.reasoning;
    parsed.raw.reasoning = {
      ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
        ? reasoning as Record<string, unknown>
        : {}),
      effort: fallback.reasoningEffort,
    };
  }
  return { sourceModel: parsed.model, targetModel: fallback.model };
}

/**
 * Async request-prepare entry point: resolves `modelEligibleAccountIds` for account-gated
 * native models before checking Pool eligibility so a healthy Pool sibling that is not
 * entitled to the requested model cannot suppress the fallback.
 */
export async function resolveMainHardLockFallbackOverride(
  body: unknown,
  config: OcxConfig,
  options: MainHardLockFallbackOptions = {},
): Promise<MainHardLockFallbackOverride | null> {
  const now = options.now ?? Date.now();
  const parsed = rawModelOf(body);
  if (!parsed) return null;
  let modelEligibleAccountIds = options.modelEligibleAccountIds;
  if (
    modelEligibleAccountIds === undefined
    && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(parsed.model)
    && resolveMainAccountHardLockFallback(config) !== undefined
    && getMainAccountHardLockStatus(config, now).state === "blocked"
    && providerCodexAccountMode(
      OPENAI_CODEX_PROVIDER_ID,
      config.providers?.[OPENAI_CODEX_PROVIDER_ID],
    ) !== "direct"
  ) {
    const excludeAccountIds = new Set([MAIN_CODEX_ACCOUNT_ID]);
    const snapshot = await (options.resolveCodexModelEntitlements ?? resolveCodexModelEntitlements)(config, {
      excludeAccountIds,
      signal: options.signal,
      nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
    });
    const entitled = entitledCodexAccountIdsForModel(snapshot, parsed.model);
    modelEligibleAccountIds = entitled
      ? new Set([...entitled].filter(candidate => !excludeAccountIds.has(candidate)))
      : undefined;
  }
  return applyMainHardLockFallbackOverride(body, config, {
    ...options,
    now,
    ...(modelEligibleAccountIds !== undefined ? { modelEligibleAccountIds } : {}),
  });
}
