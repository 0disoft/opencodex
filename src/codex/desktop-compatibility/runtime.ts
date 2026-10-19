import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getConfigDir } from "../../config/paths";
import { issueServerLeaf } from "../../claude/intercept/local-ca";
import { startConnectProxy, type ConnectProxyHandle } from "../../claude/intercept/connect-proxy";
import { didRunOptionalShutdownHooks, registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
import { isTestHomeGuardArmed } from "../../lib/test-home-guard";
import { desktopOutboundFetch, desktopProxyFor } from "../../lib/desktop-proxy-route";
import { inspectDesktopCompatibilityAuthority, loadDesktopCompatibilityAuthority, type StoredDesktopAuthority } from "./certificate-store";
import { inspectWindowsCertificateTrust } from "./windows-certificate-trust";
import { createNativeIdentityReader } from "./native-identity";
import { UsageRelayController, type UsageIdentity } from "./usage-controller";
import { createUsageControlledFetch } from "./usage-controlled-fetch";
import { startDesktopRelay, type DesktopRelayOptions } from "./relay-listener";
import { launchWindowsCodexCompatibility } from "./windows-package-launch";
import { acquireDesktopCompatibilityRuntime, bindDesktopCompatibilityLaunch } from "./runtime-ownership";
import { createDesktopConnectionStore, type DesktopConnectionStore } from "./connection-store";
import { createNativeRoutingVerifier } from "./routing-preflight";
import { createInstalledBuildProbe, type DesktopBuildAssessment } from "./installed-build";
import type { ApplyLifetime } from "./usage-activation";

export { DESKTOP_COMPATIBILITY_ASSESSED_VERSION, isAssessedDesktopInstalled } from "./installed-build";
const COMPATIBILITY_HOSTS = ["chatgpt.com", "ws.chatgpt.com"] as const;
export interface DesktopRuntimeIo {
  platform?: string;
  loadAuthority?: () => Promise<StoredDesktopAuthority>;
  trust?: (authority: StoredDesktopAuthority) => Promise<"trusted" | "not-trusted" | "unknown">;
  identity?: ReturnType<typeof createNativeIdentityReader>;
  /** Internal query seam; abort settles only after its owned query has finished. */
  buildSupported?: (signal: AbortSignal) => boolean | Promise<boolean>;
  /** Internal fixture probe factory; requires testOnly and all sandbox identity/CA seams. */
  testOnlyBuildProbe?: () => ReturnType<typeof createInstalledBuildProbe>;
  /** Isolated TLS broker peer; admitted only with every explicit sandbox seam. */
  testOnlyWebsocketPeer?: NonNullable<DesktopRelayOptions["websocketPeer"]>;
  upstreamFetch?: typeof fetch;
  connectionStore?: DesktopConnectionStore;
  routingSupported?: () => boolean;
  /** Synthetic-test execution is admitted only with explicit fixture identity and CA seams. */
  testOnly?: boolean;
}

/** Optional runtime. Import/construction/status do not start listeners or touch credentials. */
export function createDesktopCompatibilityRuntime(io: DesktopRuntimeIo = {}) {
  const platform = io.platform ?? process.platform;
  let buildProbe: ReturnType<typeof createInstalledBuildProbe> | undefined;
  let previousBuildAssessment: DesktopBuildAssessment | null = null;
  let packageProofAt: number | null = null, packageProofGeneration = 0;
  let packageCheck: { controller: AbortController; promise: Promise<boolean> } | null = null;
  const discardPackageProof = () => { packageProofAt = null; ++packageProofGeneration; packageCheck?.controller.abort(); };
  // Only this runtime's completed successful check grants a short lease. Public
  // lastResult metadata may survive an aborted probe and is never authority here.
  const packageSupported = (fresh: boolean): Promise<boolean> => {
    if (phase !== "starting" && phase !== "running") return Promise.resolve(false);
    if (packageCheck) return packageCheck.promise;
    const startedAt = Date.now();
    if (!fresh && packageProofAt !== null && startedAt >= packageProofAt && startedAt - packageProofAt < 60000) return Promise.resolve(true);
    packageProofAt = null;
    const generation = packageProofGeneration, controller = new AbortController();
    const promise = Promise.resolve().then(() => controller.signal.aborted ? false
      : io.buildSupported ? io.buildSupported(controller.signal) : buildProbe?.check() ?? false)
      .then(supported => {
        const completedAt = Date.now();
        if (controller.signal.aborted || generation !== packageProofGeneration || completedAt < startedAt
          || phase !== "starting" && phase !== "running") return false;
        if (supported !== true) return false;
        packageProofAt = completedAt; return true;
      }).catch(() => false).finally(() => { if (packageCheck?.controller === controller) packageCheck = null; });
    packageCheck = { controller, promise };
    return promise;
  };
  let routingSupported = io.routingSupported ?? (() => false);
  let contextFailure: "build_unverified" | "native_routing_unverified" | null = null;
  const contextValid = async (fresh = false) => {
    const generation = packageProofGeneration;
    try {
      if (!routingSupported()) { discardPackageProof(); contextFailure = "native_routing_unverified"; return false; }
      const supported = await packageSupported(fresh);
      if (generation !== packageProofGeneration) return false;
      contextFailure = !routingSupported() ? "native_routing_unverified" : !supported ? "build_unverified" : null;
      if (contextFailure) discardPackageProof();
    }
    catch { if (generation !== packageProofGeneration) return false; discardPackageProof(); contextFailure = "build_unverified"; }
    return contextFailure === null;
  };
  let phase: "off" | "starting" | "running" | "stopping" | "cleanup-required" = "off";
  let owned: { controller: UsageRelayController; close(): Promise<void>; pacUrl: string; fingerprint: string; deadline: number } | null = null;
  let closing: Promise<void> | null = null;
  let pendingCleanup: (() => Promise<void>) | null = null;
  let releaseOwner: (() => void) | null = null;
  const status = () => ({ phase, supported: platform === "win32", running: owned !== null, contextFailure,
    supportedActivationLifetimes: ["trial", "runtime-session"] as const,
    ...(buildProbe ? { buildAssessment: buildProbe.lastResult() ?? (previousBuildAssessment ? { ...previousBuildAssessment } : null) } : {}),
    ...(owned ? { fingerprint: owned.fingerprint, safetyDeadline: owned.deadline, usage: owned.controller.snapshot() } : {}) });
  async function stop(): Promise<ReturnType<typeof status>> {
    if (phase === "starting") throw new Error("desktop_compatibility_busy");
    if (closing) { await closing; return status(); }
    if (!pendingCleanup) return status();
    phase = "stopping";
    closing = pendingCleanup().then(() => { owned = null; pendingCleanup = null; phase = "off"; releaseOwner?.(); releaseOwner = null; })
      .catch(error => { phase = "cleanup-required"; throw error; }).finally(() => { closing = null; });
    await closing; return status();
  }
  async function start() {
    if (phase !== "off") throw new Error("desktop_compatibility_busy");
    if (platform !== "win32") throw new Error("desktop_compatibility_unsupported");
    if (io.testOnlyBuildProbe && (!io.testOnly || io.buildSupported)) throw new Error("desktop_compatibility_test_environment");
    if ((isTestHomeGuardArmed() || io.testOnlyBuildProbe || io.testOnlyWebsocketPeer) && !(io.testOnly && io.identity && io.loadAuthority && io.trust && (io.buildSupported || io.testOnlyBuildProbe) && io.connectionStore && io.routingSupported)) throw new Error("desktop_compatibility_test_environment");
    if (didRunOptionalShutdownHooks()) throw new Error("desktop_compatibility_stopping");
    try { for (const host of COMPATIBILITY_HOSTS) desktopProxyFor(new URL(`https://${host}`)); }
    catch { throw new Error("desktop_compatibility_egress_proxy_invalid"); }
    releaseOwner = acquireDesktopCompatibilityRuntime(); phase = "starting"; discardPackageProof();
    let relay: Awaited<ReturnType<typeof startDesktopRelay>> | undefined, proxy: ConnectProxyHandle | undefined;
    let pac: ReturnType<typeof Bun.serve> | undefined, timer: ReturnType<typeof setInterval> | undefined;
    let detach: (() => void) | undefined, unbindLaunch: (() => void) | undefined, controller: UsageRelayController | undefined;
    const cleanup = async () => {
      discardPackageProof();
      unbindLaunch?.();
      if (timer) clearInterval(timer); detach?.();
      // Abort transport before awaiting stream refresh so a stuck reader cannot retain sockets.
      const results = await Promise.allSettled([pac?.stop(true), proxy?.close(), relay?.close(), controller?.observeOnly(), buildProbe?.close(), packageCheck?.promise]);
      if (results.some(result => result.status === "rejected")) throw new Error("desktop_compatibility_cleanup_incomplete");
    };
    pendingCleanup = cleanup;
    try {
      if (!io.buildSupported) {
        // A fresh probe owns this start; diagnostics retain the last completed observation.
        previousBuildAssessment = buildProbe?.lastResult() ?? previousBuildAssessment;
        buildProbe = io.testOnlyBuildProbe ? io.testOnlyBuildProbe() : createInstalledBuildProbe();
      }
      if (!io.routingSupported) routingSupported = createNativeRoutingVerifier((await import("../paths")).getCodexHome());
      if (!await contextValid(true)) throw new Error(`desktop_compatibility_${contextFailure}`);
      const directory = join(getConfigDir(), "codex-desktop-compatibility");
      if (!io.loadAuthority) {
        const saved = inspectDesktopCompatibilityAuthority(directory);
        if (saved.status === "missing") throw new Error("desktop_compatibility_certificate_not_prepared");
        if (saved.status === "invalid") throw new Error("desktop_compatibility_certificate_invalid");
        if (saved.status === "expired") throw new Error("desktop_compatibility_certificate_expired");
      }
      const authority = await (io.loadAuthority?.() ?? loadDesktopCompatibilityAuthority({ directory }));
      const trust = await (io.trust?.(authority) ?? inspectWindowsCertificateTrust(authority.authority.certPem, authority.fingerprint));
      if (trust !== "trusted") throw new Error("desktop_compatibility_trust_required");
      const connections = io.connectionStore ?? createDesktopConnectionStore(directory);
      const previousConnection = connections.read();
      const deadline = authority.expiresAt - 300_000;
      if (deadline <= Date.now()) throw new Error("desktop_compatibility_certificate_expiring");
      const identity = io.identity ?? createNativeIdentityReader(join((await import("../paths")).getCodexHome(), "auth.json"), desktopOutboundFetch as typeof fetch);
      const account: UsageIdentity | null = await identity.verifyFreshIdentity();
      if (!account) throw new Error("desktop_compatibility_native_identity_unverified");
      if (didRunOptionalShutdownHooks()) throw new Error("desktop_compatibility_stopping");
      controller = new UsageRelayController(account, identity.readCurrentIdentity, identity.verifyFreshIdentity, Date.now, deadline, 180000, contextValid);
      relay = await startDesktopRelay({ leaf: issueServerLeaf(authority.authority, authority.commonName, COMPATIBILITY_HOSTS),
        fetchImpl: createUsageControlledFetch(controller, io.upstreamFetch ?? desktopOutboundFetch as typeof fetch), usageController: controller,
        ...(io.testOnlyWebsocketPeer ? { websocketPeer: io.testOnlyWebsocketPeer, websocketTransport: { proxy: false } } : {}) });
      try { proxy = await startConnectProxy(previousConnection?.connectPort ?? 0, { interceptPort: relay.port,
        interceptHosts: COMPATIBILITY_HOSTS, allowedTargets: COMPATIBILITY_HOSTS.map(host => `${host}:443`) }); }
      catch { throw new Error("desktop_compatibility_connection_unavailable"); }
      const runId = previousConnection?.id ?? randomUUID(), proxyPort = proxy.port;
      try { pac = Bun.serve({ hostname: "127.0.0.1", port: previousConnection?.pacPort ?? 0, fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "GET" || req.headers.has("origin") || url.origin !== `http://127.0.0.1:${pac!.port}` || url.pathname !== `/${runId}/proxy.pac`) return new Response(null, { status: 404 });
        return new Response(String.raw`function FindProxyForURL(url, host) { var target = /^(https|wss):\/\/(chatgpt\.com|ws\.chatgpt\.com)(?::443)?(?:[/?#]|$)/i.exec(url); return Date.now() < ${deadline} && target && target[2].toLowerCase() === host.toLowerCase() ? "PROXY 127.0.0.1:${proxyPort}; DIRECT" : "DIRECT"; }`,
          { headers: { "content-type": "application/x-ns-proxy-autoconfig", "cache-control": "no-store" } });
      } }); } catch { throw new Error("desktop_compatibility_connection_unavailable"); }
      const connection = await connections.publish({ version: 1, id: runId, connectPort: proxyPort, pacPort: pac.port! });
      if (connection.id !== runId || connection.connectPort !== proxyPort || connection.pacPort !== pac.port) throw new Error("desktop_compatibility_connection_changed");
      if (didRunOptionalShutdownHooks()) throw new Error("desktop_compatibility_stopping");
      const active = controller; let ticking = false, deadlineHandled = false, lastContextCheck = Date.now();
      timer = setInterval(() => {
        if (ticking) return; ticking = true;
        const expired = Date.now() >= deadline;
        const work = (async () => {
          const state = active.snapshot();
          const contextCadence = state.mode === "apply" && state.activationLifetime !== "runtime-session" ? 10000 : 60000;
          if (!expired && (Date.now() < lastContextCheck || Date.now() - lastContextCheck >= contextCadence)) {
            lastContextCheck = Date.now();
            if (!await contextValid(true) && active.snapshot().mode === "apply") { await active.observeOnly(); return; }
            await active.verifySessionIdentity();
          }
          if (expired && !deadlineHandled) { deadlineHandled = true; discardPackageProof(); await active.observeOnly(); }
          else await active.expireIfNeeded();
        })();
        void work.catch(() => {}).finally(() => { ticking = false; });
      }, 1000); timer.unref();
      owned = { controller, close: cleanup, fingerprint: authority.fingerprint, deadline, pacUrl: `http://127.0.0.1:${pac.port}/${runId}/proxy.pac` };
      phase = "running";
      const launchedBy = owned;
      unbindLaunch = bindDesktopCompatibilityLaunch(owned.pacUrl,
        () => owned === launchedBy && phase === "running" && Date.now() < deadline);
      detach = registerOptionalShutdownHook("codex-desktop-compatibility", () => { void stop().catch(() => {}); });
      return status();
    } catch (error) {
      try { await cleanup(); pendingCleanup = null; phase = "off"; releaseOwner?.(); releaseOwner = null; }
      catch { phase = "cleanup-required"; throw new Error("desktop_compatibility_cleanup_incomplete"); }
      throw error;
    }
  }
  async function apply(accountWideConsent: boolean, lifetime: ApplyLifetime = "trial") {
    const current = owned;
    if (!current || phase !== "running") throw new Error("desktop_compatibility_not_running");
    const generation = current.controller.snapshot().generation, valid = await contextValid(true);
    if (owned !== current || phase !== "running") throw new Error("desktop_compatibility_not_running");
    if (generation !== current.controller.snapshot().generation) return { accepted: false, reason: "superseded", ...current.controller.snapshot() };
    if (!valid) { await current.controller.observeOnly(); throw new Error(`desktop_compatibility_${contextFailure}`); }
    const result = await current.controller.activate({ scope: "account-ui-compatibility", accountWideConsent, lifetime });
    if (owned !== current || phase !== "running") { await current.controller.observeOnly(); return { ...result, accepted: false, reason: "runtime-stopped" }; }
    return result;
  }
  return { status, start, stop, apply,
    async observe() { if (owned) await owned.controller.observeOnly(); return status(); },
    async launch() {
      if (!owned || phase !== "running") throw new Error("desktop_compatibility_not_running");
      const current = owned;
      if (!await contextValid(true)) throw new Error(`desktop_compatibility_${contextFailure}`);
      if (owned !== current || phase !== "running") throw new Error("desktop_compatibility_not_running");
      return launchWindowsCodexCompatibility(current.pacUrl);
    },
    /** Internal native launch context; management status never returns the control endpoint. */
    getPacUrl: () => owned?.pacUrl ?? null,
  };
}
export type DesktopCompatibilityRuntime = ReturnType<typeof createDesktopCompatibilityRuntime>;
