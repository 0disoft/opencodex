/** Explicit in-process ownership. No PID lookup, discovery, daemon, or auto-restart. */
export interface OwnedWorker {
  listen(): Promise<{ address: string; port: number }> | { address: string; port: number };
  close(): Promise<void> | void;
}
export interface WorkerContext {
  generation: number;
  signal: AbortSignal;
  authorization: string;
  onExit(): void;
}
export interface OwnerManagerOptions {
  owner: object;
  createWorker(context: WorkerContext): OwnedWorker;
  startupMs?: number;
  shutdownMs?: number;
  sessionMs?: number;
}
export interface Activation {
  authorized?: boolean;
  authorization?: string;
}
export interface GenerationLease {
  readonly generation: number;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}
type Phase = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
interface Generation {
  generation: number;
  authorization: string;
  state: Phase;
  abort: AbortController;
  worker?: OwnedWorker;
  ready?: Promise<GenerationLease>;
  stopPromise?: Promise<void>;
  sessionTimer?: ReturnType<typeof setTimeout>;
}
function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}
export function createOwnerManager({owner, createWorker, startupMs = 5000,
  shutdownMs = 5000, sessionMs = 300000}: OwnerManagerOptions) {
  if (!owner || typeof owner !== 'object' || typeof createWorker !== 'function') throw new Error('Owner and worker factory required');
  for (const value of [startupMs, shutdownMs, sessionMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1) throw new Error('Invalid deadline');
  }
  let current: Generation | undefined;
  let nextGeneration = 0, draining = false, poisoned = false;
  const checkOwner = (caller: object) => { if (caller !== owner) throw new Error('Wrong owner'); };
  function dispose(record: Generation): Promise<void> {
    if (record.stopPromise) return record.stopPromise;
    record.state = 'stopping';
    clearTimeout(record.sessionTimer);
    record.abort.abort();
    record.stopPromise = bounded(Promise.resolve().then(() => record.worker?.close()), shutdownMs, 'Shutdown deadline exceeded')
      .then(() => { record.state = 'stopped'; if (current === record) current = undefined; })
      .catch((error: unknown) => { record.state = 'failed'; poisoned = true; throw error; });
    return record.stopPromise;
  }
  return {
    status() { return {generation: current?.generation ?? null, state: current?.state ?? 'stopped', draining, poisoned}; },
    start(caller: object, {authorized = false, authorization}: Activation = {}): Promise<GenerationLease> {
      checkOwner(caller);
      if (authorized !== true || typeof authorization !== 'string' || authorization.length < 40 || /[\r\n]/.test(authorization)) {
        throw new Error('Explicit authorization and ephemeral capability required');
      }
      if (draining || poisoned) throw new Error('Manager unavailable');
      if (current) {
        if (current.authorization !== authorization) throw new Error('Active generation configuration differs');
        if (current.state === 'starting' || current.state === 'ready') {
          if (!current.ready) throw new Error('Reentrant startup');
          return current.ready;
        }
        throw new Error('Previous generation has not stopped');
      }
      const record: Generation = {generation: ++nextGeneration, authorization, state: 'starting', abort: new AbortController()};
      current = record;
      const onExit = () => {
        if (current !== record || record.state === 'stopping' || record.state === 'stopped') return;
        record.state = 'failed'; record.abort.abort();
        void dispose(record).catch(() => {});
      };
      try { record.worker = createWorker({generation: record.generation, signal: record.abort.signal, authorization, onExit}); }
      catch (error) { current = undefined; throw error; }
      const worker = record.worker;
      // A factory may synchronously report exit. Never schedule a post-disposal timer.
      if (current === record && record.state === 'starting' && !record.abort.signal.aborted) {
        record.sessionTimer = setTimeout(() => { void dispose(record).catch(() => {}); }, sessionMs);
      }
      record.ready = bounded(Promise.resolve().then(() => {
        if (record.abort.signal.aborted) throw new Error('Stale readiness');
        return worker.listen();
      }), startupMs, 'Startup deadline exceeded').then(address => {
        if (current !== record || record.state !== 'starting' || record.abort.signal.aborted) throw new Error('Stale readiness');
        if (!address || address.address !== '127.0.0.1' || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) {
          throw new Error('Invalid loopback readiness');
        }
        record.state = 'ready';
        return Object.freeze({generation: record.generation, host: address.address, port: address.port, stop: () => dispose(record)});
      }).catch(async (error: unknown) => { await dispose(record); throw error; });
      return record.ready;
    },
    stop(caller: object): Promise<void> { checkOwner(caller); return current ? dispose(current) : Promise.resolve(); },
    shutdown(caller: object): Promise<void> { checkOwner(caller); draining = true; return current ? dispose(current) : Promise.resolve(); },
  };
}
export type OwnerManager = ReturnType<typeof createOwnerManager>;
