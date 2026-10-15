import { openCodeZenBaseUrl } from "../types/opencode-zen";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Older Zen configs allowed Chat/Responses overrides for Gemini. Repair only the loaded copy. */
export function sanitizeOpenCodeZenOverridesForLoad(parsed: unknown): void {
  const providers = record(record(parsed)?.providers);
  const provider = providers && Object.hasOwn(providers, "opencode-zen")
    ? record(providers["opencode-zen"]) : undefined;
  if (!provider || !openCodeZenBaseUrl(provider)) return;
  const overrides = record(provider.modelAdapters);
  if (!overrides) return;
  let changed = false;
  for (const [model, adapter] of Object.entries(overrides)) {
    if (model.trim().toLowerCase().startsWith("gemini-")
      && (adapter === "openai-chat" || adapter === "openai-responses")) {
      delete overrides[model];
      changed = true;
    }
  }
  if (!changed) return;
  if (Object.keys(overrides).length === 0) delete provider.modelAdapters;
  console.warn("OpenCode Zen Gemini models now use the native Google API; obsolete Chat/Responses overrides were ignored while loading config.json.");
}
