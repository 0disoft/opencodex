import {createOwnerManager, type OwnerManagerOptions} from './owner-manager';
import {createManagedIngress, type ManagedIngressOptions} from './managed-ingress';
import {snapshotProxyRoutes, type OpaqueProxyRoute} from '../opaque-proxy-tunnel';

export interface OwnedIngressManagerOptions {
  owner: object;
  candidates: readonly OpaqueProxyRoute[];
  allowTarget(authority: string): boolean;
  ingress?: Omit<ManagedIngressOptions, 'authorization' | 'candidates' | 'allowTarget'>;
  manager?: Omit<OwnerManagerOptions, 'owner' | 'createWorker'>;
}
/** Executable composition seam. No activation, registration, or listener at import. */
export function createOwnedIngressManager({owner, candidates, allowTarget, ingress = {}, manager = {}}: OwnedIngressManagerOptions) {
  if (!Array.isArray(candidates) || !candidates.length || typeof allowTarget !== 'function') throw new Error('Explicit routes and target policy required');
  let routes = snapshotProxyRoutes(candidates), revision = 0, epoch = 0;
  let active: ReturnType<typeof createManagedIngress> | undefined;
  const lifecycle = createOwnerManager({...manager, owner, createWorker:({authorization, onExit}) => {
    epoch++;
    const worker = createManagedIngress({...ingress, authorization, candidates:routes, allowTarget});
    active = worker;
    worker.server.once('close', () => { if (active === worker) active = undefined; onExit(); });
    worker.server.once('error', onExit);
    return worker;
  }});
  return {
    ...lifecycle,
    routeVersion: () => ({revision, epoch, generation:lifecycle.status().generation}),
    /** Only future accepted connections change routes. Existing/queued streams never replay. */
    updateRoutes(caller: object, expected: {revision: number; epoch: number; generation: number | null}, candidates: readonly OpaqueProxyRoute[]): number {
      if (caller !== owner) throw new Error('Wrong owner');
      const status = lifecycle.status();
      if (status.draining || status.poisoned || status.state === 'stopping' || status.state === 'failed') throw new Error('Manager unavailable');
      if (!expected || expected.revision !== revision || expected.epoch !== epoch || expected.generation !== status.generation) throw new Error('Stale route version');
      const next = snapshotProxyRoutes(candidates);
      active?.replaceCandidates(next);
      routes = next;
      return ++revision;
    },
  };
}
