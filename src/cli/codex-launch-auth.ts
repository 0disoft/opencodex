import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readConfigDiagnostics, websocketsEnabled } from "../config";
import { getCodexHome } from "../codex/paths";
import { readBoundedCodexConfig } from "../codex/inject/bounded-config-reader";
import { buildProviderTableBlockForTarget } from "../codex/inject/config-toml";
import { standaloneCodexRoutingTarget, validateCodexRoutingTarget } from "../codex/inject/routing-target";
import { readClientConnectionState } from "../client/state";

/** Config classification is a startup hint; credentials need an independently bound destination. */
export function codexCredentialDestinationIsTrusted(): boolean {
  try {
    const diagnostics = readConfigDiagnostics();
    if (diagnostics.error || diagnostics.source === "fallback") return false;
    const cfg = diagnostics.config;
    let target = standaloneCodexRoutingTarget(cfg.port, cfg);
    if (cfg.runtimeRole === "client") {
      // Direct clients bind to persisted connection state; link clients use an authless relay.
      const connection = readClientConnectionState();
      if (connection.kind !== "connected" || connection.value.transport === "link") return false;
      target = validateCodexRoutingTarget({ baseUrl: `${connection.value.serverUrl}/v1`, requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" });
    }
    const url = new URL(target.baseUrl);
    if (!target.requiresAdmissionToken) return false;
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) return false;
    const home = getCodexHome();
    const content = readBoundedCodexConfig(join(home, "config.toml"));
    if (content === null) return false;
    const config = Bun.TOML.parse(content) as Record<string, unknown>;
    // Codex layers project configs and profiles after the home. Without proving those layers,
    // conservatively leave authentication to the user's environment.
    if (config.profile !== undefined || config.model_provider !== "opencodex") return false;
    for (const key of ["openai_base_url", "experimental_realtime_ws_base_url"]) {
      if (config[key] !== undefined && config[key] !== target.baseUrl) return false;
    }
    for (let directory = process.cwd(); ; directory = dirname(directory)) {
      const projectConfig = join(directory, ".codex", "config.toml");
      if (projectConfig !== join(home, "config.toml")) {
        try { lstatSync(projectConfig); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
      }
      // A nested .git need not be Codex's root: custom project_root_markers can select
      // an outer workspace. Without proving that selection, inspect every ancestor.
      if (dirname(directory) === directory) break;
    }
    const providers = config.model_providers as Record<string, unknown> | undefined;
    const provider = providers?.opencodex as Record<string, unknown> | undefined;
    const expected = (Bun.TOML.parse(buildProviderTableBlockForTarget(target, websocketsEnabled(cfg))) as { model_providers: { opencodex: Record<string, unknown> } }).model_providers.opencodex;
    // Display names are cosmetic; every transport and credential-bearing field must match
    // the block emitted by our writer for this installation/connection.
    if (!provider || typeof provider.name !== "string") return false;
    const { name: _name, ...transport } = provider;
    const { name: _expectedName, ...expectedTransport } = expected;
    return isDeepStrictEqual(transport, expectedTransport);
  } catch { return false; }
}
