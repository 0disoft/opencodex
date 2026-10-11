import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnthropicInstanceFixture, INSTANCE_FIXTURE_INSTANCES, type AnthropicInstanceFixture } from "../helpers/anthropic-instance-fixture";

let f: AnthropicInstanceFixture;
beforeEach(async () => { f = await createAnthropicInstanceFixture(); await f.seed(); });
afterEach(async () => { await f?.dispose(); });

for (const instance of INSTANCE_FIXTURE_INSTANCES) {
  const other = instance === "anthropic" ? "anthropic2" : "anthropic";
  test(`${instance}: account health projection reads only its equal-ID cooldown`, async () => {
    const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
    const now = Date.now();
    const own = f.routing.anthropicRoutingFor(instance);
    own.recordAnthropicAccountRefusal(f.config, f.ids[0], 403, "60", now);
    const ownAccount = f.store.getAccountSet(instance)!.accounts.find(row => row.id === f.ids[0])!;
    const peerAccount = f.store.getAccountSet(other)!.accounts.find(row => row.id === f.ids[0])!;
    const cooled = projectStoredOAuthAccountHealth(instance, ownAccount, now, { observeOnly: true });
    const peer = projectStoredOAuthAccountHealth(other, peerAccount, now, { observeOnly: true });
    expect(cooled.status).toBe("cooldown");
    expect(cooled).toMatchObject({ until: new Date(now + 60_000).toISOString() });
    expect(peer.status).toBe("healthy");
    own.clearAnthropicAccountCooldown(f.ids[0]);
    expect(projectStoredOAuthAccountHealth(instance, ownAccount, now, { observeOnly: true }).status).toBe("healthy");
  });
  test(`${instance}: reset-derived quota cooldown is separate from sibling rate-limit cooldown`, async () => {
    const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
    const now = Math.floor(Date.now() / 1000) * 1000;
    const headers = new Headers({ "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-reset": String((now + 120_000) / 1000) });
    f.routing.anthropicRoutingFor(instance).recordAnthropicAccount429(f.config, f.ids[0], null, now, headers);
    f.routing.anthropicRoutingFor(other).recordAnthropicAccountRefusal(f.config, f.ids[0], 403, "30", now);
    const ownAccount = f.store.getAccountSet(instance)!.accounts[0]!;
    const peerAccount = f.store.getAccountSet(other)!.accounts[0]!;
    expect(projectStoredOAuthAccountHealth(instance, ownAccount, now, { observeOnly: true })).toMatchObject({ status: "cooldown", reason: "quota", until: new Date(now + 120_000).toISOString() });
    expect(projectStoredOAuthAccountHealth(other, peerAccount, now, { observeOnly: true })).toMatchObject({ status: "cooldown", reason: "rate_limit", until: new Date(now + 30_000).toISOString() });
  });
}

test("a settled reset lifts a retry-after cooldown and replaces the cached bars", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
  const { getCachedProviderAccountQuota, setCachedProviderAccountQuotaForTests } = await import("../../src/providers/quota/account-cache");
  const now = Date.now();
  const instance = "anthropic" as const;
  const other = "anthropic2" as const;
  const id = f.ids[0];
  const headers = new Headers({
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor((now + 86_400_000) / 1000)),
  });
  f.routing.anthropicRoutingFor(instance).recordAnthropicAccount429(f.config, id, "86400", now, headers);
  f.routing.anthropicRoutingFor(other).recordAnthropicAccount429(f.config, id, "86400", now, headers);
  setCachedProviderAccountQuotaForTests(instance, id, { fiveHourPercent: 0, weeklyPercent: 100, updatedAt: now });
  setCachedProviderAccountQuotaForTests(other, id, { fiveHourPercent: 0, weeklyPercent: 100, updatedAt: now });
  f.modelQuota.anthropicModelQuotaFor(instance).observeAnthropicFamilyQuota(id, [{
    label: "Fable", scope: "model", percent: 100, rejected: true, resetAt: now + 86_400_000,
  }], now, true);
  const account = f.store.getAccountSet(instance)!.accounts.find(row => row.id === id)!;
  expect(projectStoredOAuthAccountHealth(instance, account, now, { observeOnly: true })).toMatchObject({ status: "cooldown", reason: "rate_limit" });
  expect(f.modelQuota.anthropicFamilyRejected(id, "claude-fable-5", now)).toBe(true);

  const resetAt = new Date(now + 3_600_000).toISOString();
  globalThis.fetch = (async () => Response.json({
    five_hour: { utilization: 0, resets_at: resetAt },
    seven_day: { utilization: 0, resets_at: resetAt },
    seven_day_fable: { utilization: 4, resets_at: resetAt },
    limits: [],
  })) as typeof fetch;
  await admitAnthropicAccountAfterReset(instance, id);

  expect(projectStoredOAuthAccountHealth(instance, account, Date.now(), { observeOnly: true }).status).toBe("healthy");
  expect(f.modelQuota.anthropicFamilyRejected(id, "claude-fable-5", Date.now())).toBe(false);
  expect(getCachedProviderAccountQuota(instance, id)).toMatchObject({ fiveHourPercent: 0, weeklyPercent: 0 });
  const peer = f.store.getAccountSet(other)!.accounts.find(row => row.id === id)!;
  expect(projectStoredOAuthAccountHealth(other, peer, Date.now(), { observeOnly: true }).status).toBe("cooldown");
  expect(getCachedProviderAccountQuota(other, id)?.weeklyPercent).toBe(100);
});

test("a failed usage reread still leaves the reset account eligible", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
  const { getCachedProviderAccountQuota, setCachedProviderAccountQuotaForTests } = await import("../../src/providers/quota/account-cache");
  const now = Date.now();
  const id = f.ids[0];
  const headers = new Headers({
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor((now + 3_600_000) / 1000)),
  });
  f.routing.anthropicRoutingFor("anthropic").recordAnthropicAccount429(f.config, id, "3600", now, headers);
  setCachedProviderAccountQuotaForTests("anthropic", id, { fiveHourPercent: 100, weeklyPercent: 100, updatedAt: now });
  globalThis.fetch = (async () => { throw new Error("usage endpoint down"); }) as typeof fetch;
  await admitAnthropicAccountAfterReset("anthropic", id);
  const account = f.store.getAccountSet("anthropic")!.accounts.find(row => row.id === id)!;
  expect(projectStoredOAuthAccountHealth("anthropic", account, Date.now(), { observeOnly: true }).status).toBe("healthy");
  expect(getCachedProviderAccountQuota("anthropic", id)?.weeklyPercent).not.toBe(100);
});

test("a five-hour-only reset lifts the account cooldown without releasing a model family", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
  const now = Date.now();
  const id = f.ids[0];
  const headers = new Headers({
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor((now + 86_400_000) / 1000)),
  });
  f.routing.anthropicRoutingFor("anthropic").recordAnthropicAccount429(f.config, id, "86400", now, headers);
  f.modelQuota.anthropicModelQuotaFor("anthropic").observeAnthropicFamilyQuota(id, [{
    label: "Fable", scope: "model", percent: 100, rejected: true, resetAt: now + 86_400_000,
  }], now, true);
  globalThis.fetch = (async () => Response.json({
    five_hour: { utilization: 0, resets_at: new Date(now + 3_600_000).toISOString() },
  })) as typeof fetch;
  await admitAnthropicAccountAfterReset("anthropic", id);
  const account = f.store.getAccountSet("anthropic")!.accounts.find(row => row.id === id)!;
  expect(projectStoredOAuthAccountHealth("anthropic", account, Date.now(), { observeOnly: true }).status).toBe("healthy");
  expect(f.modelQuota.anthropicFamilyRejected(id, "claude-fable-5", Date.now())).toBe(true);
});
