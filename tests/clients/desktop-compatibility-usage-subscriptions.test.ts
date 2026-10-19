import { expect, test } from 'bun:test';
import { UsageRelayController } from '../../src/codex/desktop-compatibility/usage-controller';
import { createUsageControlledFetch } from '../../src/codex/desktop-compatibility/usage-controlled-fetch';
import { evaluateUsageRewrite } from '../../src/codex/desktop-compatibility/usage-policy';

const account = { id: 'fixture-account', userId: 'fixture-user', plan: 'pro', structure: 'personal' } as const;
const usage = { account_id: account.id, user_id: account.userId, plan_type: account.plan,
  rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: 123456 } },
  credits: { has_credits: false, unlimited: false, balance: '0' }, spend_control: { reached: false } };
const exchange = { method: 'POST', pathname: '/backend-api/wham/usage/subscriptions', status: 200 };
const snapshot = { ...usage, generated_at_ms: 1000, renewal_seconds: 60, unknown: { count: 37 } };
const consent = { scope: 'account-ui-compatibility', accountWideConsent: true } as const;
const makeController = () => new UsageRelayController(account, async () => account, async () => account, () => 1000, 100000);

test('flat POST snapshot observes exhaustion and correction retains renewal, windows, credits and unknown fields', async () => {
  const controller = makeController();
  expect(await controller.rewriteJson(JSON.stringify(snapshot), exchange)).toBeNull();
  expect((await controller.activate(consent)).accepted).toBe(true);
  const original = structuredClone(snapshot);
  expect(JSON.parse((await controller.rewriteJson(JSON.stringify(snapshot), exchange))!)).toEqual({
    ...snapshot, rate_limit: { ...snapshot.rate_limit, allowed: true, limit_reached: false },
  });
  expect(snapshot).toEqual(original);
  expect(controller.snapshot().appCacheConfirmed).toBe(false);
});

test('POST wrapper preserves the request and invalidates validators only on a corrected response', async () => {
  const controller = makeController();
  await controller.rewriteJson(JSON.stringify(snapshot), exchange);
  await controller.activate(consent);
  const input = new Request('https://chatgpt.com' + exchange.pathname, { method: 'POST', headers: { 'x-fixture': 'kept' } });
  const forward = createUsageControlledFetch(controller, (async (request, init) => {
    expect(request).toBe(input); expect(init).toBeUndefined();
    return Response.json(snapshot, { headers: { etag: 'fixture', digest: 'fixture', 'last-modified': 'fixture', 'content-md5': 'fixture' } });
  }) as typeof fetch);
  const changed = await forward(input);
  expect(changed.headers.get('cache-control')).toBe('no-store');
  for (const header of ['etag', 'digest', 'last-modified', 'content-md5']) expect(changed.headers.has(header)).toBe(false);
  expect((await changed.json()).rate_limit.allowed).toBe(true);
  await controller.observeOnly();
  const unchanged = await forward(input);
  expect(unchanged.headers.get('etag')).toBe('fixture'); expect(await unchanged.json()).toEqual(snapshot);
});

for (const invalid of [{ generated_at_ms: -1 }, { generated_at_ms: 1.5 }, { renewal_seconds: 0 },
  { renewal_seconds: '60' }, { account_id: '' }, { account_id: 'foreign' }, { credits: undefined },
  { spend_control: undefined }]) test(`invalid complete POST remains original: ${JSON.stringify(invalid)}`, async () => {
  const controller = makeController();
  expect(await controller.rewriteJson(JSON.stringify({ ...snapshot, ...invalid }), exchange)).toBeNull();
  expect((await controller.activate(consent)).accepted).toBe(false);
});

test('unknown HTTP methods, statuses, endpoints and non-JSON subscription bodies pass through', async () => {
  const controller = makeController();
  for (const [method, pathname, status, contentType] of [
    ['GET', exchange.pathname, 200, 'application/json'], ['POST', '/backend-api/wham/usage', 200, 'application/json'],
    ['POST', exchange.pathname, 403, 'application/json'], ['POST', exchange.pathname, 200, 'text/event-stream'],
  ] as const) {
    const upstream = new Response(JSON.stringify(snapshot), { status, headers: { 'content-type': contentType } });
    const forward = createUsageControlledFetch(controller, (async () => upstream) as typeof fetch);
    expect(await forward('https://chatgpt.com' + pathname, { method })).toBe(upstream);
  }
});

test('partial push permits omitted retained fields but complete HTTP snapshots require them', () => {
  const partial = { account_id: account.id, user_id: account.userId, plan_type: account.plan, rate_limit: usage.rate_limit };
  const context = { enabled: true, mode: 'apply', status: 200, account } as const;
  expect(evaluateUsageRewrite(partial, { ...context, pathname: '/backend-api/wham/usage' }).changed).toBe(false);
  const result = evaluateUsageRewrite(partial, { ...context, snapshotKind: 'partial-push' });
  expect(result.changed).toBe(true);
  expect(result.value).toEqual({ ...partial, rate_limit: { ...partial.rate_limit, allowed: true, limit_reached: false } });
  expect(Object.hasOwn(result.value as object, 'credits')).toBe(false);
  expect(Object.hasOwn(result.value as object, 'spend_control')).toBe(false);
});

for (const protection of [{ spend_control: { reached: true } }, { credits: { overage_limit_reached: true } },
  { credits: { has_credits: true } }, { credits: { unlimited: true } }, { credits: 'unknown' },
  { rate_limit_reached_type: { type: 'spend_limit_reached' } },
  { additional_rate_limits: [{ limit_name: 'gpt-reserve', rate_limit: { allowed: true } }] },
]) test(`partial push retains explicit protection without guessing prior upsell: ${JSON.stringify(protection)}`, () => {
  const value = { account_id: account.id, user_id: account.userId, plan_type: account.plan,
    rate_limit: usage.rate_limit, ...protection };
  const result = evaluateUsageRewrite(value, { enabled: true, mode: 'apply', status: 200, account, snapshotKind: 'partial-push' });
  expect(result.changed).toBe(false); expect(result.value).toBe(value);
});

for (const method of ['GET', 'POST'] as const) test(`available ${method} usage retains original bytes and validators`, async () => {
  const controller = makeController();
  await controller.rewriteJson(JSON.stringify(snapshot), exchange); await controller.activate(consent);
  const value = { ...snapshot, rate_limit: { ...usage.rate_limit, allowed: true, limit_reached: false } };
  const bytes = Buffer.from('\n ' + JSON.stringify(value, null, 2) + ' \r\n');
  const forward = createUsageControlledFetch(controller, (async () => new Response(bytes, {
    headers: { 'content-type': 'application/json', etag: 'original', digest: 'original' },
  })) as typeof fetch);
  const response = await forward('https://chatgpt.com' + (method === 'GET' ? '/backend-api/wham/usage' : exchange.pathname), { method });
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get('etag')).toBe('original'); expect(response.headers.get('digest')).toBe('original');
  expect(controller.snapshot().outputs).toBe(0); expect(controller.snapshot().mode).toBe('observe');
});

for (const [name, bytes] of [
  ['malformed JSON', Buffer.from(' \r\n { invalid JSON } \n')],
  ['invalid UTF-8', Buffer.from([0xff, 0x80, 0x00])],
  ['oversized JSON', Buffer.from(JSON.stringify({ ...snapshot, noise: 'x'.repeat(262144) }))],
  ['invalid subscription metadata', Buffer.from('\n ' + JSON.stringify({ ...snapshot, renewal_seconds: 0 }) + '\n')],
] as const) test(`invalid POST ${name} passes through byte-for-byte during Apply`, async () => {
  const controller = makeController();
  await controller.rewriteJson(JSON.stringify(snapshot), exchange); await controller.activate(consent);
  const forward = createUsageControlledFetch(controller, (async () => new Response(bytes, {
    headers: { 'content-type': 'application/json', etag: 'original' },
  })) as typeof fetch);
  const response = await forward('https://chatgpt.com' + exchange.pathname, { method: 'POST' });
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get('etag')).toBe('original'); expect(controller.snapshot().outputs).toBe(0);
});

for (const method of ['GET', 'POST'] as const) test(`${method} account mismatch during Apply yields zero output and original bytes`, async () => {
  const controller = makeController();
  await controller.rewriteJson(JSON.stringify(snapshot), exchange); await controller.activate(consent);
  const bytes = Buffer.from('\n ' + JSON.stringify({ ...snapshot, account_id: 'foreign' }, null, 2));
  const forward = createUsageControlledFetch(controller, (async () => new Response(bytes, {
    headers: { 'content-type': 'application/json', etag: 'original' },
  })) as typeof fetch);
  const response = await forward('https://chatgpt.com' + (method === 'GET' ? '/backend-api/wham/usage' : exchange.pathname), { method });
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get('etag')).toBe('original'); expect(controller.snapshot().outputs).toBe(0);
});
