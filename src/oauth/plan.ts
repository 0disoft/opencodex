import type { OAuthCredentials } from "./types";

/** Display-only upstream tier; never infer a plan from normalized quota percentages. */
export function normalizeOAuthPlan(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const plan = value.trim();
  return plan.length <= 64 && /^[a-z0-9_.-]+$/.test(plan) ? plan : undefined;
}

/** An observed unknown clears old metadata; an account replacement cannot inherit a plan. */
export function mergeOAuthPlan(fresh: OAuthCredentials, previous: OAuthCredentials): string | null | undefined {
  if (fresh.plan !== undefined) return normalizeOAuthPlan(fresh.plan) ?? null;
  const before = previous.anthropicIdentity?.accountUuid ?? previous.accountId ?? previous.email;
  const after = fresh.anthropicIdentity?.accountUuid ?? fresh.accountId ?? fresh.email;
  if (before !== undefined && after !== undefined && before !== after) return undefined;
  return previous.plan === null ? null : normalizeOAuthPlan(previous.plan);
}
