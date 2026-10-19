import { UsageActivation, type ApplyLifetime, type ApplyScope } from './usage-activation';
import { UsageRefreshRegistry } from './usage-refresh';
import { evaluateUsageRewrite, type UsageRewriteContext } from './usage-policy';

export type UsageIdentity = NonNullable<UsageRewriteContext['account']> & { credentialGeneration?: string };
type Registration = NonNullable<ReturnType<UsageRefreshRegistry['register']>>;
type Exchange = { method: string; pathname: string; status: number };
const PUSH_TOPIC = 'codex-work-usage-push-v1';
const MAX_PUSH_ENTRIES = 128;
const same = (a: UsageIdentity | null, b: UsageIdentity) => a !== null
  && a.id === b.id && a.userId === b.userId && a.plan === b.plan && a.structure === b.structure
  && a.credentialGeneration === b.credentialGeneration;
const object = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value);

/** Response-level controller. Construction never starts a listener, timer or trust operation. */
export class UsageRelayController {
  private readonly account: UsageIdentity;
  private readonly key: string;
  private readonly refresh = new UsageRefreshRegistry();
  private readonly activation: UsageActivation;
  private jsonSnapshots = 0;
  private streamSnapshots = 0;
  private lastSnapshotAt: number | null = null;
  constructor(account: UsageIdentity, private readonly readCurrentIdentity: () => Promise<UsageIdentity | null>,
    verifyFreshIdentity: () => Promise<UsageIdentity | null>, private readonly clock: () => number,
    private readonly expiresAt: number, timeoutMs = 180000, private readonly contextValid: () => boolean | Promise<boolean> = () => true) {
    if (!account.id || !account.userId || !['plus', 'pro'].includes(account.plan)
      || account.structure !== 'personal' || !Number.isFinite(expiresAt) || expiresAt <= clock()) {
      throw new Error('A verified supported identity and finite safety deadline are required');
    }
    this.account = { ...account };
    this.key = JSON.stringify([account.id, account.userId, account.plan, account.credentialGeneration ?? null]);
    this.activation = new UsageActivation(this.key, key => this.refresh.refresh(key), async () => {
      return same(await verifyFreshIdentity(), this.account) ? this.key : null;
    }, clock, timeoutMs);
  }
  snapshot() { return { ...this.activation.snapshot(), trackedStreams: this.refresh.size, expired: this.clock() >= this.expiresAt,
    observation: { jsonSnapshots: this.jsonSnapshots, streamSnapshots: this.streamSnapshots,
      validatedActiveStreams: this.refresh.boundSize, lastSnapshotAt: this.lastSnapshotAt,
      sourceProcessVerified: false as const, composerRecoveryVerified: false as const } }; }
  private async checkContext() { try { return await this.contextValid(); } catch { return false; } }
  async activate(options: { scope: ApplyScope; accountWideConsent: boolean; lifetime?: ApplyLifetime }) {
    const generation = this.activation.snapshot().generation, valid = await this.checkContext();
    if (generation !== this.activation.snapshot().generation) return { accepted: false, reason: 'superseded', ...this.snapshot() };
    if (!valid) { this.activation.invalidateIdentity(); return { accepted: false, reason: 'native-context-changed', ...this.snapshot() }; }
    if (this.clock() >= this.expiresAt) { this.activation.invalidateIdentity(); return { accepted: false, reason: 'safety-deadline', ...this.snapshot() }; }
    return this.activation.activate(options);
  }
  observeOnly() { return this.activation.observeOnly(); }
  expireIfNeeded() { return this.activation.expireIfNeeded(); }
  /** Idle session checks read only the existing native login snapshot, never the network. */
  async verifySessionIdentity() {
    const state = this.activation.snapshot();
    if (state.mode !== 'apply' || state.activationLifetime !== 'runtime-session') return;
    let current: UsageIdentity | null;
    try { current = await this.readCurrentIdentity(); } catch { current = null; }
    if (state.generation !== this.activation.snapshot().generation) return;
    if (!same(current, this.account) || this.clock() >= this.expiresAt) this.activation.invalidateIdentity();
  }
  registerStream(exchange: Exchange, close: () => Promise<void>): Registration | null {
    if (exchange.status !== 200) return null;
    return this.refresh.register(exchange.method, exchange.pathname, close);
  }
  registerPushStream(pathname: string, close: () => Promise<void>): Registration | null {
    return this.refresh.registerPush(pathname, close);
  }
  private validUsage(value: unknown): value is Record<string, unknown> {
    return object(value) && value.account_id === this.account.id && value.user_id === this.account.userId
      && value.plan_type === this.account.plan && object(value.rate_limit)
      && typeof value.rate_limit.allowed === 'boolean' && typeof value.rate_limit.limit_reached === 'boolean';
  }
  private rejectUsage(value: unknown, stream?: Registration | null) {
    const foreign = object(value) && (['account_id', 'user_id', 'plan_type'] as const).some((key, index) =>
      key in value && value[key] !== [this.account.id, this.account.userId, this.account.plan][index]);
    if (foreign) this.activation.invalidateIdentity();
    else if (this.activation.snapshot().activationLifetime === 'runtime-session') this.activation.observe(this.key, 'protected');
    stream?.exclude();
  }
  private validEnvelope(value: unknown, push = false): value is Record<string, unknown> {
    return object(value) && value.version === 1 && typeof value.stream_id === 'string' && !!value.stream_id
      && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
      && (!push || (value.generated_at_ms == null || Number.isSafeInteger(value.generated_at_ms) && Number(value.generated_at_ms) >= 0)
        && (value.change_published_at_ms == null || Number.isSafeInteger(value.change_published_at_ms)
          && Number(value.change_published_at_ms) >= 0));
  }
  /** Complete HTTP snapshots and partial push snapshots have separate policy contracts. */
  async rewriteJson(text: string, exchange: Exchange, stream?: Registration | null): Promise<string | null> {
    const subscription = exchange.method === 'POST' && exchange.pathname === '/backend-api/wham/usage/subscriptions';
    if (exchange.status !== 200 || !(subscription || exchange.method === 'GET'
      && ['/backend-api/wham/usage', '/backend-api/wham/usage/stream'].includes(exchange.pathname))) return null;
    if (Buffer.byteLength(text, 'utf8') > 262144) { this.rejectUsage(null, stream); return null; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { this.rejectUsage(null, stream); return null; }
    if (subscription && (!object(parsed) || !Number.isSafeInteger(parsed.generated_at_ms) || Number(parsed.generated_at_ms) < 0
      || typeof parsed.renewal_seconds !== 'number' || !Number.isFinite(parsed.renewal_seconds) || parsed.renewal_seconds <= 0)) {
      this.rejectUsage(null, stream); return null;
    }
    const envelope = !subscription && object(parsed) && 'usage' in parsed ? parsed : null;
    if (exchange.pathname.endsWith('/stream') && !envelope || envelope && !this.validEnvelope(envelope)) {
      this.rejectUsage(null, stream); return null;
    }
    const generation = this.activation.snapshot().generation;
    const result = await this.rewriteUsage(envelope ? envelope.usage : parsed,
      { enabled: true, mode: 'observe', status: exchange.status, pathname: exchange.pathname,
        snapshotKind: 'complete', account: this.account }, generation, exchange.pathname.endsWith('/stream'), stream);
    if (!result) return null;
    return this.serializeOutput(envelope ? { ...envelope, usage: result } : result, generation, stream);
  }
  /** Decode only the shared wire array and known subscribe catchups, never arbitrary nested payloads. */
  async rewritePushMessage(text: string, stream?: Registration | null): Promise<string | null> {
    if (Buffer.byteLength(text, 'utf8') > 262144) { this.rejectUsage(null, stream); return null; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { this.rejectUsage(null, stream); return null; }
    if (!Array.isArray(parsed) || parsed.length > MAX_PUSH_ENTRIES) { this.rejectUsage(null, stream); return null; }
    const snapshots: Record<string, unknown>[] = [];
    let count = parsed.length, invalid = false;
    const collect = (entry: unknown) => {
      if (!object(entry) || entry.type !== 'message' || entry.topic_id !== PUSH_TOPIC
        || !object(entry.payload) || entry.payload.type !== 'usage.snapshot') return;
      const payload = entry.payload.payload;
      if (!this.validEnvelope(payload, true)) { invalid = true; return; }
      // The native consumer ignores nullish generated_at_ms before its cache merge.
      // Such a snapshot proves nothing and must not taint later data on this stream.
      if (payload.generated_at_ms == null) return;
      if (!this.validUsage(payload.usage)) { this.rejectUsage(payload.usage, stream); invalid = true; return; }
      snapshots.push(payload);
    };
    for (const entry of parsed) {
      collect(entry);
      if (!object(entry) || !object(entry.reply) || entry.reply.type !== 'subscribe' || entry.reply.topic_id !== PUSH_TOPIC) continue;
      if (typeof entry.reply.recovered !== 'boolean') { invalid = true; continue; }
      if (!entry.reply.recovered) continue;
      if (entry.reply.catchups === undefined) continue;
      if (!Array.isArray(entry.reply.catchups) || (count += entry.reply.catchups.length) > MAX_PUSH_ENTRIES) { invalid = true; break; }
      for (const catchup of entry.reply.catchups) collect(catchup);
    }
    if (invalid) { this.rejectUsage(null, stream); return null; }
    if (!snapshots.length) return null;
    let generation = this.activation.snapshot().generation;
    const consentEpoch = this.activation.consentEpoch();
    const candidates: { snapshot: Record<string, unknown>; value: Record<string, unknown> }[] = [];
    for (const snapshot of snapshots) {
      const value = await this.rewriteUsage(snapshot.usage, { enabled: true, mode: 'observe', status: 200,
        snapshotKind: 'partial-push', account: this.account }, generation, true, stream);
      // A same-session recovery cancels older candidates, but a later original
      // exhaustion may be evaluated in its new generation under the same consent.
      if (consentEpoch !== this.activation.consentEpoch()) return null;
      const current = this.activation.snapshot().generation;
      if (current !== generation) { candidates.length = 0; generation = current; }
      else if (value) candidates.push({ snapshot, value });
    }
    if (!candidates.length) return null;
    // Publish candidates only after the batch's own recovery ordering is known.
    // External Observe/identity/context revocation rejects the entire old batch.
    for (const candidate of candidates) candidate.snapshot.usage = candidate.value;
    return this.serializeOutput(parsed, generation, stream);
  }
  private async serializeOutput(value: unknown, generation: number, stream?: Registration | null): Promise<string | null> {
    // This is the final async boundary for the whole response/wire batch. An
    // earlier candidate's identity check cannot authorize output after it.
    let current: UsageIdentity | null;
    try { current = await this.readCurrentIdentity(); } catch { current = null; }
    if (generation !== this.activation.snapshot().generation) return null;
    if (!same(current, this.account) || this.clock() >= this.expiresAt) {
      this.activation.invalidateIdentity(); stream?.exclude(); return null;
    }
    if (stream && !stream.bind(this.key)) return null;
    return this.activation.recordOutput(this.key, generation) ? JSON.stringify(value) : null;
  }
  private async rewriteUsage(original: unknown, context: UsageRewriteContext, observedGeneration: number,
    streaming: boolean, stream?: Registration | null): Promise<Record<string, unknown> | null> {
    if (this.clock() >= this.expiresAt) { this.activation.invalidateIdentity(); stream?.exclude(); return null; }
    let current: UsageIdentity | null;
    try { current = await this.readCurrentIdentity(); } catch { current = null; }
    if (!same(current, this.account)) { this.activation.invalidateIdentity(); stream?.exclude(); return null; }
    // Do not apply an activation that raced this response's identity read.
    if (observedGeneration !== this.activation.snapshot().generation) return null;
    if (this.clock() >= this.expiresAt) { this.activation.invalidateIdentity(); stream?.exclude(); return null; }
    if (!this.validUsage(original)) { this.rejectUsage(original, stream); return null; }
    const rate = original.rate_limit as Record<string, unknown>;
    if (stream && !stream.bind(this.key)) return null;
    // Identity-checked responses received by this relay do not establish the
    // sending process or prove that an authoritative UI cache consumed them.
    if (streaming) this.streamSnapshots = Math.min(Number.MAX_SAFE_INTEGER, this.streamSnapshots + 1);
    else this.jsonSnapshots = Math.min(Number.MAX_SAFE_INTEGER, this.jsonSnapshots + 1);
    this.lastSnapshotAt = this.clock();
    const observed = evaluateUsageRewrite(original, context);
    this.activation.observe(this.key, observed.eligible ? 'exhausted'
      : rate.allowed === true && rate.limit_reached === false ? 'available' : 'protected');
    const state = this.activation.snapshot();
    if (state.mode !== 'apply' || state.generation !== observedGeneration) return null;
    const result = evaluateUsageRewrite(original, { ...context, mode: 'apply' });
    if (!result.changed) return null;
    // Observe and unchanged responses never spawn an installed-package probe.
    const valid = await this.checkContext();
    if (state.generation !== this.activation.snapshot().generation) return null;
    if (!valid) { this.activation.invalidateIdentity(); stream?.exclude(); return null; }
    // The caller rechecks identity, deadline and generation for the complete
    // response after every candidate's asynchronous context check has settled.
    return result.value as Record<string, unknown>;
  }
}
