/**
 * Put one Anthropic account back into the pool after a settled reset grant.
 *
 * A shared-quota 429 that also carries Retry-After is stored with source
 * "retry-after" until that deadline. A later usage probe cannot clear that
 * source: captureAnthropicCooldownRecovery only claims reset-derived cooldowns.
 * The grant itself has to lift admission. The usage reread is best-effort.
 * The grant is already spent, and a failed reread must not restore the cooldown.
 *
 * Model-family exclusions are not cleared here. Only that reread may release
 * one, and only when its payload proves the family is no longer rejected.
 */
import { anthropicRoutingFor } from "../oauth/anthropic-routing";
import type { AnthropicInstanceId } from "./anthropic-instance";
import { fetchAnthropicAccountQuota } from "./quota/anthropic-account-quota";
import { forgetCachedProviderAccountQuota } from "./quota/account-cache";
import { anthropicCooldownRecoveryFor } from "./quota/anthropic-cooldown-recovery";

export async function admitAnthropicAccountAfterReset(
  instance: AnthropicInstanceId,
  accountId: string,
): Promise<void> {
  // Move any usage read that started before the grant onto a stale generation
  // before dropping the cached row, so it cannot republish the pre-reset bars.
  anthropicCooldownRecoveryFor(instance).noteAnthropicCooldownMutation(accountId);
  anthropicRoutingFor(instance).clearAnthropicAccountCooldown(accountId);
  forgetCachedProviderAccountQuota(instance, accountId);
  await fetchAnthropicAccountQuota(instance, accountId, true);
}
