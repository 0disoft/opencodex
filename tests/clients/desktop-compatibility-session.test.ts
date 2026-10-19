import { expect, test } from 'bun:test';
import { UsageActivation, type ApplyLifetime } from '../../src/codex/desktop-compatibility/usage-activation';
import { UsageRelayController, type UsageIdentity } from '../../src/codex/desktop-compatibility/usage-controller';

const account: UsageIdentity = { id: 'session-account', userId: 'session-user', plan: 'pro', structure: 'personal', credentialGeneration: 'one' };
const exhausted = { account_id: account.id, user_id: account.userId, plan_type: account.plan,
  rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: 123456 } },
  spend_control: { reached: false }, credits: { has_credits: false, unlimited: false } };
const available = { ...exhausted, rate_limit: { ...exhausted.rate_limit, allowed: true, limit_reached: false } };
const exchange = { method: 'GET', pathname: '/backend-api/wham/usage', status: 200 };
const session = { scope: 'account-ui-compatibility', accountWideConsent: true, lifetime: 'runtime-session' } as const;
const broker = '/backend-api/pages/realtime-broker/u123/ws';
const message = (usage: unknown = exhausted) => ({ type: 'message', topic_id: 'codex-work-usage-push-v1',
  payload: { type: 'usage.snapshot', payload: { version: 1, stream_id: 'session-stream', sequence: 1, generated_at_ms: 1000, usage } } });

function fixture() {
  let now = 1000, current: UsageIdentity | null = account, context = true, checks = 0;
  let verify: () => boolean | Promise<boolean> = () => context;
  const controller = new UsageRelayController(account, async () => current, async () => current, () => now, 2000000,
    180000, () => { checks++; return verify(); });
  const rewrite = (value: unknown = exhausted) => controller.rewriteJson(JSON.stringify(value), exchange);
  return { controller, rewrite, checks: () => checks, setNow: (value: number) => { now = value; },
    setIdentity: (value: UsageIdentity | null) => { current = value; }, setContext: (value: boolean) => { context = value; },
    setVerify: (value: typeof verify) => { verify = value; } };
}
async function activate(io: ReturnType<typeof fixture>) {
  await io.rewrite(); expect((await io.controller.activate(session)).accepted).toBe(true);
}

for (const lifetime of [undefined, 'trial'] as const) test(`legacy activation ${lifetime ?? 'omitted'} still expires after three minutes`, async () => {
  let now = 1000, refreshed = 0;
  const activation = new UsageActivation('account', async () => (++refreshed, { requested: 0, closed: 0, failed: 0 }), async () => 'account', () => now);
  activation.observe('account', 'exhausted');
  expect((await activation.activate({ scope: 'account-ui-compatibility', accountWideConsent: true, lifetime })).accepted).toBe(true);
  expect(activation.snapshot().activationLifetime).toBe('trial');
  now += 180000;
  expect(activation.recordOutput('account', activation.snapshot().generation)).toBe(false);
  expect(await activation.expireIfNeeded()).toBe(true);
  expect(activation.snapshot()).toMatchObject({ mode: 'observe', activationLifetime: null });
  expect(refreshed).toBe(2);
});

test('session remains authorized beyond the trial timeout without changing quota values', async () => {
  const io = fixture(); await activate(io); io.setNow(1000000);
  expect(await io.controller.expireIfNeeded()).toBe(false);
  const changed = JSON.parse((await io.rewrite())!);
  expect(changed).toEqual({ ...exhausted, rate_limit: { ...exhausted.rate_limit, allowed: true, limit_reached: false } });
  expect(io.controller.snapshot()).toMatchObject({ mode: 'apply', activationLifetime: 'runtime-session', outputs: 1, appCacheConfirmed: false });
});

for (const [label, value] of [
  ['recovery', available], ['spending protection', { ...exhausted, spend_control: { reached: true } }],
  ['credits', { ...exhausted, credits: { has_credits: true, unlimited: false } }],
  ['unknown credits', { ...exhausted, credits: {} }], ['unknown rate schema', { ...exhausted, rate_limit: {} }],
] as const) test(`session passes through ${label} and resumes only on a new eligible original`, async () => {
  const io = fixture(); await activate(io);
  const generation = io.controller.snapshot().generation, checks = io.checks();
  expect(await io.rewrite(value)).toBeNull();
  expect(io.controller.snapshot().generation).toBeGreaterThan(generation);
  expect(io.controller.snapshot()).toMatchObject({ mode: 'apply', activationLifetime: 'runtime-session' });
  expect(io.checks()).toBe(checks);
  expect(await io.rewrite()).not.toBeNull(); expect(io.checks()).toBe(checks + 1);
});

test('recovery and re-exhaustion never refresh or close shared broker streams again', async () => {
  const io = fixture(); let closed = 0;
  const initial = io.controller.registerPushStream(broker, async () => { closed++; })!;
  await io.controller.rewritePushMessage(JSON.stringify([message()]), initial);
  expect((await io.controller.activate(session)).accepted).toBe(true); expect(closed).toBe(1);
  const current = io.controller.registerPushStream(broker, async () => { closed++; })!;
  for (let index = 0; index < 3; index++) {
    expect(await io.controller.rewritePushMessage(JSON.stringify([message(available)]), current)).toBeNull();
    expect(await io.controller.rewritePushMessage(JSON.stringify([message()]), current)).not.toBeNull();
  }
  expect(closed).toBe(1);
  await io.controller.observeOnly(); expect(closed).toBe(2);
  expect(io.controller.snapshot()).toMatchObject({ mode: 'observe', activationLifetime: null });
  expect(await io.rewrite()).toBeNull();
});

test('a recovered record invalidates the entire pending push batch but retains session consent', async () => {
  const io = fixture(); await activate(io);
  expect(await io.controller.rewritePushMessage(JSON.stringify([message(), message(available)]))).toBeNull();
  expect(io.controller.snapshot()).toMatchObject({ mode: 'apply', activationLifetime: 'runtime-session', outputs: 0 });
  expect(await io.controller.rewritePushMessage(JSON.stringify([message()]))).not.toBeNull();
});

for (const container of ['wire', 'catchups'] as const) for (const earlierExhaustion of [false, true]) test(`${container} session recovery followed by a newer exhaustion corrects only the new generation (older candidate: ${earlierExhaustion})`, async () => {
  const io = fixture(); await activate(io);
  const snapshots = [...(earlierExhaustion ? [message()] : []), message(available), message()];
  const input = container === 'wire' ? snapshots
    : [{ id: 'subscribe', reply: { type: 'subscribe', topic_id: 'codex-work-usage-push-v1', recovered: true, catchups: snapshots } }];
  const output = JSON.parse((await io.controller.rewritePushMessage(JSON.stringify(input)))!);
  const received = container === 'wire' ? output : output[0].reply.catchups;
  expect(received.map((entry: ReturnType<typeof message>) => entry.payload.payload.usage)).toEqual([
    ...(earlierExhaustion ? [exhausted] : []), available,
    { ...exhausted, rate_limit: { ...exhausted.rate_limit, allowed: true, limit_reached: false } },
  ]);
  expect(io.controller.snapshot()).toMatchObject({ mode: 'apply', activationLifetime: 'runtime-session', outputs: 1,
    phase: 'response-produced-app-confirmation-needed' });
});

for (const change of ['observe', 'identity', 'replacement-consent'] as const) test(`external ${change} still rejects a whole batch after its own recovery`, async () => {
  const io = fixture(); await activate(io);
  let entered!: () => void, release!: (value: boolean) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  io.setVerify(() => (entered(), new Promise(resolve => { release = resolve; })));
  const pending = io.controller.rewritePushMessage(JSON.stringify([message(available), message()])); await waiting;
  if (change === 'identity') io.setIdentity({ ...account, credentialGeneration: 'replacement' });
  else await io.controller.observeOnly();
  if (change === 'replacement-consent') {
    io.setVerify(() => true); await io.rewrite();
    expect((await io.controller.activate(session)).accepted).toBe(true);
  }
  release(true); expect(await pending).toBeNull();
  expect(io.controller.snapshot().outputs).toBe(0);
  expect(io.controller.snapshot().activationLifetime).toBe(change === 'replacement-consent' ? 'runtime-session' : null);
});

for (const change of ['observe', 'identity', 'context', 'deadline', 'foreign payload'] as const) test(`session consent is revoked by ${change} and never resumes automatically`, async () => {
  const io = fixture(); await activate(io);
  if (change === 'observe') await io.controller.observeOnly();
  if (change === 'identity') io.setIdentity({ ...account, credentialGeneration: 'two' });
  if (change === 'context') io.setContext(false);
  if (change === 'deadline') io.setNow(2000000);
  expect(await io.rewrite(change === 'foreign payload' ? { ...exhausted, account_id: 'foreign' } : exhausted)).toBeNull();
  expect(io.controller.snapshot()).toMatchObject({ mode: 'observe', activationLifetime: null });
  io.setIdentity(account); io.setContext(true); io.setNow(1000);
  expect(await io.rewrite()).toBeNull();
});

test('idle session identity validation revokes replacement credentials without probing upstream context', async () => {
  const io = fixture(); await activate(io); const checks = io.checks();
  io.setIdentity({ ...account, credentialGeneration: 'two' });
  await io.controller.verifySessionIdentity();
  expect(io.checks()).toBe(checks);
  expect(io.controller.snapshot()).toMatchObject({ mode: 'observe', activationLifetime: null });
});

test('recovery invalidates an asynchronous candidate while allowing a later session response', async () => {
  const io = fixture(); await activate(io);
  let entered!: () => void, release!: (value: boolean) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  io.setVerify(() => (entered(), new Promise(resolve => { release = resolve; })));
  const pending = io.rewrite(); await waiting;
  expect(await io.rewrite(available)).toBeNull(); release(true);
  expect(await pending).toBeNull();
  io.setVerify(() => true); expect(await io.rewrite()).not.toBeNull();
});

for (const failure of [false, true]) test(`session recovery while initial refresh is pending ${failure ? 'cannot retain failed consent' : 'does not revoke consent'}`, async () => {
  let release!: (value: { requested: number; closed: number; failed: number }) => void;
  const activation = new UsageActivation('account', () => new Promise(resolve => { release = resolve; }), async () => 'account');
  activation.observe('account', 'exhausted');
  const pending = activation.activate(session); await Bun.sleep(0);
  activation.observe('account', 'available');
  release(failure ? { requested: 1, closed: 0, failed: 1 } : { requested: 1, closed: 1, failed: 0 });
  expect((await pending).accepted).toBe(!failure);
  expect(activation.snapshot().activationLifetime).toBe(failure ? null : 'runtime-session');
});

test('unsupported lifetimes cannot grant consent or start refresh', async () => {
  let refreshed = 0;
  const activation = new UsageActivation('account', async () => (++refreshed, { requested: 0, closed: 0, failed: 0 }), async () => 'account');
  activation.observe('account', 'exhausted');
  expect((await activation.activate({ ...session, lifetime: 'persistent' as ApplyLifetime })).accepted).toBe(false);
  expect(refreshed).toBe(0); expect(activation.snapshot().activationLifetime).toBeNull();
});
