import { expect, test } from 'bun:test';
import { UsageRelayController, type UsageIdentity } from '../../src/codex/desktop-compatibility/usage-controller';

const account: UsageIdentity = { id: 'fixture-account', userId: 'fixture-user', plan: 'pro', structure: 'personal', credentialGeneration: 'one' };
const partial = { account_id: account.id, user_id: account.userId, plan_type: account.plan,
  rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: 123456 } },
  unknown: { count: 9 }, additional_rate_limits: [] };
const topic = 'codex-work-usage-push-v1', broker = '/backend-api/pages/realtime-broker/u123/ws';
const consent = { scope: 'account-ui-compatibility', accountWideConsent: true } as const;
const message = (usage: unknown = partial) => ({ type: 'message', topic_id: topic, unknown: 'kept',
  payload: { type: 'usage.snapshot', payload: { version: 1, stream_id: 'fixture-stream', sequence: 3,
    generated_at_ms: 1000, change_published_at_ms: 999, usage, unknown: { count: 5 } } } });
const corrected = { ...partial, rate_limit: { ...partial.rate_limit, allowed: true, limit_reached: false } };
function fixture() {
  let now = 1000, current: UsageIdentity | null = account, check: () => boolean | Promise<boolean> = () => true;
  const controller = new UsageRelayController(account, async () => current, async () => current, () => now, 100000,
    180000, () => check());
  return { controller, setIdentity: (value: UsageIdentity | null) => { current = value; },
    setNow: (value: number) => { now = value; }, setCheck: (value: typeof check) => { check = value; } };
}
async function activate(controller: UsageRelayController, lifetime: 'trial' | 'runtime-session' = 'trial') {
  expect(await controller.rewritePushMessage(JSON.stringify([message()]))).toBeNull();
  expect((await controller.activate({ ...consent, lifetime })).accepted).toBe(true);
}

test('only the exact topic snapshot and subscribe catchups change, retaining metadata and other entries', async () => {
  const { controller } = fixture(); await activate(controller);
  const other = { type: 'message', topic_id: 'other-topic', payload: message().payload, spaces: '  ' };
  const reply = { id: 'subscription', reply: { type: 'subscribe', topic_id: topic, recovered: true, catchups: [message(), other], resume: 5 } };
  const input = [other, message(), reply, { id: 7, reply: { type: 'ack' } }];
  const before = structuredClone(input);
  const output = await controller.rewritePushMessage(JSON.stringify(input));
  const changedMessage = message(corrected);
  expect(JSON.parse(output!)).toEqual([other, changedMessage,
    { ...reply, reply: { ...reply.reply, catchups: [changedMessage, other] } }, input[3]]);
  expect(input).toEqual(before);
  expect(controller.snapshot().outputs).toBe(1);
  expect(controller.snapshot().observation.sourceProcessVerified).toBe(false);
  expect(controller.snapshot().appCacheConfirmed).toBe(false);
});

test('refresh closes only broker streams bound by validated original usage, once', async () => {
  const { controller } = fixture(); let closed = 0, unrelatedClosed = 0, foreignClosed = 0;
  for (const path of ['/dictation/stream', broker + '?other=1', broker + '/extra', '/backend-api/pages/realtime-broker/uX/ws']) {
    expect(controller.registerPushStream(path, async () => {})).toBeNull();
  }
  const bound = controller.registerPushStream(broker, async () => { closed++; })!;
  const unrelated = controller.registerPushStream(broker, async () => { unrelatedClosed++; })!;
  const foreign = controller.registerPushStream(broker, async () => { foreignClosed++; })!;
  await controller.rewritePushMessage(JSON.stringify([{ ...message(), topic_id: 'other-topic' }]), unrelated);
  await controller.rewritePushMessage(JSON.stringify([message({ ...partial, account_id: 'foreign' })]), foreign);
  await controller.rewritePushMessage(JSON.stringify([message()]), bound);
  expect(controller.snapshot().observation.validatedActiveStreams).toBe(1);
  const activation = await controller.activate(consent);
  expect(activation.accepted).toBe(true); expect(closed).toBe(1);
  expect(unrelatedClosed).toBe(0); expect(foreignClosed).toBe(0);
  await controller.observeOnly(); expect(closed).toBe(1);
  unrelated.release(); foreign.release();
});

for (const lifetime of ['trial', 'runtime-session'] as const) test(`subscribe acknowledgement without catchups never taints later ${lifetime} usage on the same stream`, async () => {
  const { controller } = fixture(); await activate(controller);
  if (lifetime === 'runtime-session') {
    await controller.observeOnly();
    await controller.rewritePushMessage(JSON.stringify([message()]));
    expect((await controller.activate({ ...consent, lifetime })).accepted).toBe(true);
  }
  const stream = controller.registerPushStream(broker, async () => {})!;
  const acknowledgement = [{ id: 'subscription', reply: { type: 'subscribe', topic_id: topic, recovered: true } }];
  expect(await controller.rewritePushMessage(JSON.stringify(acknowledgement), stream)).toBeNull();
  expect(controller.snapshot().observation.validatedActiveStreams).toBe(0);
  expect(await controller.rewritePushMessage(JSON.stringify([message()]), stream)).not.toBeNull();
  expect(controller.snapshot().observation.validatedActiveStreams).toBe(1);
  stream.release();
});

for (const usage of [{ ...partial, account_id: '' }, { ...partial, account_id: 'foreign' },
  { ...partial, user_id: 'foreign' }, { ...partial, plan_type: 'team' },
]) test(`foreign or empty identity cannot bind or observe: ${JSON.stringify(usage)}`, async () => {
  const { controller } = fixture();
  expect(await controller.rewritePushMessage(JSON.stringify([message(usage)]))).toBeNull();
  expect(controller.snapshot().observation.streamSnapshots).toBe(0);
  expect((await controller.activate(consent)).accepted).toBe(false);
});

test('unowned wire shapes and unknown versions stay raw and cannot become refresh targets', async () => {
  const { controller } = fixture(); let closed = 0;
  const stream = controller.registerPushStream(broker, async () => { closed++; })!;
  const changedVersion = message(); changedVersion.payload.payload.version = 2;
  const otherType = message(); otherType.payload.type = 'usage.other';
  for (const value of [{ usage: partial }, message(), [{ ...message(), topic_id: 'other' }], [otherType], [changedVersion], []]) {
    const raw = ' \n' + JSON.stringify(value) + '\n ';
    expect(await controller.rewritePushMessage(raw, stream)).toBeNull();
  }
  await activate(controller); expect(closed).toBe(0);
  stream.release();
});

test('oversized text, too many wire entries and too many catchups are never partially corrected', async () => {
  const { controller } = fixture(); await activate(controller);
  for (const text of [JSON.stringify([message({ ...partial, noise: 'x'.repeat(262144) })]),
    JSON.stringify(Array.from({ length: 129 }, () => message())),
    JSON.stringify([{ id: 1, reply: { type: 'subscribe', topic_id: topic, recovered: true,
      catchups: Array.from({ length: 128 }, () => message()) } }]), '{invalid']) {
    expect(await controller.rewritePushMessage(text)).toBeNull();
  }
  expect(controller.snapshot().outputs).toBe(0);
});

for (const lifetime of ['trial', 'runtime-session'] as const) for (const generated of [undefined, null]) test(`${lifetime} ignores nullish generated_at_ms ${String(generated)} before identity, observation or stream binding`, async () => {
  const { controller } = fixture(); await activate(controller, lifetime);
  const stream = controller.registerPushStream(broker, async () => {})!;
  const ignored = message({ ...partial, account_id: 'foreign' });
  const payload: Record<string, unknown> = ignored.payload.payload;
  if (generated === undefined) delete payload.generated_at_ms; else payload.generated_at_ms = generated;
  const before = controller.snapshot();
  expect(await controller.rewritePushMessage(JSON.stringify([ignored]), stream)).toBeNull();
  expect(controller.snapshot()).toEqual(before);
  expect(await controller.rewritePushMessage(JSON.stringify([message()]), stream)).not.toBeNull();
  expect(controller.snapshot().observation.validatedActiveStreams).toBe(1);
  stream.release();
});

test('nullish generated_at_ms cannot establish the original exhaustion needed for activation', async () => {
  const { controller } = fixture();
  const ignored = message(); const payload: Record<string, unknown> = ignored.payload.payload;
  delete payload.generated_at_ms;
  await controller.rewritePushMessage(JSON.stringify([ignored]));
  expect(controller.snapshot().observation.streamSnapshots).toBe(0);
  expect((await controller.activate(consent)).accepted).toBe(false);
});

test('unrecovered catchups are ignored without tainting or advancing session state', async () => {
  const { controller } = fixture(); await activate(controller, 'runtime-session');
  const stream = controller.registerPushStream(broker, async () => {})!;
  const before = controller.snapshot();
  for (const catchups of [[message(), message({ ...partial, account_id: 'foreign' })], 'ignored-shape']) {
    const ignored = [{ id: 'subscription', reply: { type: 'subscribe', topic_id: topic, recovered: false, catchups } }];
    expect(await controller.rewritePushMessage(JSON.stringify(ignored), stream)).toBeNull();
    expect(controller.snapshot()).toEqual(before);
  }
  expect(await controller.rewritePushMessage(JSON.stringify([message()]), stream)).not.toBeNull();
  stream.release();
});

test('malformed recovered or non-null generated timestamps remain raw and taint only the stream', async () => {
  const { controller } = fixture(); await activate(controller);
  for (const invalid of [[{ id: 'subscription', reply: { type: 'subscribe', topic_id: topic, recovered: 'true', catchups: [message()] } }],
    [{ ...message(), payload: { type: 'usage.snapshot', payload: { ...message().payload.payload, generated_at_ms: '1000' } } }]]) {
    const stream = controller.registerPushStream(broker, async () => {})!;
    expect(await controller.rewritePushMessage(JSON.stringify(invalid), stream)).toBeNull();
    expect(await controller.rewritePushMessage(JSON.stringify([message()]), stream)).toBeNull();
    stream.release();
  }
});

test('a later recovered snapshot cancels corrections prepared earlier in the same wire array', async () => {
  const { controller } = fixture(); await activate(controller);
  expect(await controller.rewritePushMessage(JSON.stringify([message(), message(corrected)]))).toBeNull();
  expect(controller.snapshot().mode).toBe('observe'); expect(controller.snapshot().outputs).toBe(0);
});

test('an invalid target later in the array prevents binding and any partial output', async () => {
  const { controller } = fixture(); await activate(controller);
  const stream = controller.registerPushStream(broker, async () => {})!;
  expect(await controller.rewritePushMessage(JSON.stringify([message(), message({ ...partial, account_id: '' })]), stream)).toBeNull();
  expect(controller.snapshot().outputs).toBe(0); expect(controller.snapshot().observation.validatedActiveStreams).toBe(0);
  stream.release();
});

for (const change of ['observe', 'credential', 'expiry', 'context'] as const) test(`pending push correction is discarded after ${change}`, async () => {
  const fixtureIo = fixture(), { controller } = fixtureIo; await activate(controller);
  let entered!: () => void, release!: (value: boolean) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  fixtureIo.setCheck(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const pending = controller.rewritePushMessage(JSON.stringify([message()])); await waiting;
  if (change === 'observe') await controller.observeOnly();
  if (change === 'credential') fixtureIo.setIdentity({ ...account, credentialGeneration: 'two' });
  if (change === 'expiry') fixtureIo.setNow(100000);
  release(change !== 'context');
  expect(await pending).toBeNull(); expect(controller.snapshot().outputs).toBe(0);
});

test('Reserve allowance is preserved even without an incoming upsell or credit record', async () => {
  const { controller } = fixture(); await activate(controller);
  const usage = { ...partial, additional_rate_limits: [{ limit_name: 'gpt-reserve', rate_limit: { allowed: true } }] };
  expect(await controller.rewritePushMessage(JSON.stringify([message(usage)]))).toBeNull();
  expect(controller.snapshot().mode).toBe('observe'); expect(controller.snapshot().outputs).toBe(0);
});

test('a foreign snapshot taints the same broker stream while a correction is awaiting its context check', async () => {
  const fixtureIo = fixture(), { controller } = fixtureIo; await activate(controller);
  const stream = controller.registerPushStream(broker, async () => {})!;
  let entered!: () => void, release!: (value: boolean) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  fixtureIo.setCheck(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const pending = controller.rewritePushMessage(JSON.stringify([message()]), stream); await waiting;
  await controller.rewritePushMessage(JSON.stringify([message({ ...partial, account_id: 'foreign' })]), stream);
  release(true);
  expect(await pending).toBeNull(); expect(controller.snapshot().outputs).toBe(0);
  expect(controller.snapshot().observation.validatedActiveStreams).toBe(0);
  stream.release();
});

test('foreign identity and unknown push version during Apply yield no replacement or output', async () => {
  const { controller } = fixture(); await activate(controller);
  const unknown = message(); unknown.payload.payload.version = 2;
  for (const value of [[message({ ...partial, account_id: 'foreign' })], [unknown],
    [{ ...message(), topic_id: 'unrelated' }]]) {
    const raw = '\r\n ' + JSON.stringify(value, null, 2) + '\n';
    const changed = await controller.rewritePushMessage(raw);
    expect(changed).toBeNull(); expect(changed ?? raw).toBe(raw);
    expect(controller.snapshot().outputs).toBe(0);
  }
});
