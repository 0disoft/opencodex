import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyClaudeInterceptSettings,
  captureClaudeInterceptSettingsRollback,
  buildClaudeInterceptEnv,
  inspectClaudeInterceptSettings,
  migrateClaudeInterceptSettings,
  removeClaudeInterceptSettings,
} from "../../src/claude/intercept/settings";
import { claudeInterceptEnabled, claudeInterceptProxyPort } from "../../src/claude/intercept/runtime";
import { configSchema } from "../../src/config/schema/config-schema";

const CA = "/home/u/.opencodex/claude-intercept/ca.pem";
const env = buildClaudeInterceptEnv(8846, CA, "test-token");
const LOOPBACK = "127.0.0.1,localhost,::1";
/** What apply writes into a block that had no NO_PROXY of its own. */
const written = { ...env, NO_PROXY: LOOPBACK };

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-intercept-settings-"));
}

function seed(configDir: string, doc: unknown): void {
  writeFileSync(join(configDir, "settings.json"), JSON.stringify(doc));
}

function readSettings(configDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as Record<string, unknown>;
}

test("env block shape", () => {
  expect(env).toEqual({ HTTPS_PROXY: "http://opencodex:test-token@127.0.0.1:8846", NODE_EXTRA_CA_CERTS: CA });
});

test("apply creates settings.json when absent and is idempotent", () => {
  const configDir = dir();
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "absent" });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ env: written });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: false });
  expect(readSettings(configDir)).toEqual({ env: written });
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "applied", env });
});

test("apply preserves unrelated settings and env keys", () => {
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ model: "opus", env: { ANTHROPIC_MODEL: "gpt-x", FOO: "1" }, permissions: { allow: [] } }));
  applyClaudeInterceptSettings(env, configDir);
  expect(readSettings(configDir)).toEqual({
    model: "opus",
    env: { ANTHROPIC_MODEL: "gpt-x", FOO: "1", ...written },
    permissions: { allow: [] },
  });
});

test("a previous port is stale and gets rewritten; a foreign proxy is left alone", () => {
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: CA } }));
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "stale", env: { HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: CA } });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ env: written });

  const foreign = dir();
  writeFileSync(join(foreign, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } }));
  expect(inspectClaudeInterceptSettings(env, foreign).kind).toBe("foreign");
  expect(applyClaudeInterceptSettings(env, foreign)).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(readSettings(foreign)).toEqual({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } });

  // A loopback proxy with someone else's CA is not ours either.
  const otherCa = dir();
  writeFileSync(join(otherCa, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:8080", NODE_EXTRA_CA_CERTS: "/etc/mitm/ca.pem" } }));
  expect(inspectClaudeInterceptSettings(env, otherCa).kind).toBe("foreign");
});

test("migrate rewrites an owned legacy env but never creates or touches foreign state", () => {
  // A pre-auth apply left a bare loopback URL; the CA anchor still marks the env as ours.
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ theme: "dark", env: { HTTPS_PROXY: "http://127.0.0.1:8846", NODE_EXTRA_CA_CERTS: CA } }));
  expect(migrateClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ theme: "dark", env: written });
  expect(migrateClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: false });

  // Absent env stays absent — migration must not enable the integration by itself.
  const missing = dir();
  expect(migrateClaudeInterceptSettings(env, missing)).toMatchObject({ ok: true, changed: false });
  expect(existsSync(join(missing, "settings.json"))).toBe(false);

  // Foreign env is never overwritten from the runtime path either.
  const foreign = dir();
  writeFileSync(join(foreign, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } }));
  expect(migrateClaudeInterceptSettings(env, foreign)).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(readSettings(foreign)).toEqual({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } });
});

test("remove deletes only owned values and drops an emptied env block", () => {
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ model: "opus", env: { ...written } }));
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ model: "opus" });
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: false });

  const foreign = dir();
  writeFileSync(join(foreign, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:8080", NODE_EXTRA_CA_CERTS: "/etc/mitm/ca.pem" } }));
  expect(removeClaudeInterceptSettings(CA, foreign)).toMatchObject({ ok: true, changed: false });
  expect(readSettings(foreign)).toEqual({ env: { HTTPS_PROXY: "http://127.0.0.1:8080", NODE_EXTRA_CA_CERTS: "/etc/mitm/ca.pem" } });

  const missing = dir();
  expect(removeClaudeInterceptSettings(CA, missing)).toMatchObject({ ok: true, changed: false });
});

test("corrupt settings.json is reported, never overwritten", () => {
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), "{ not json");
  expect(inspectClaudeInterceptSettings(env, configDir).kind).toBe("unreadable");
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: false, reason: "unreadable" });
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: false, reason: "unreadable" });
  expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe("{ not json");
});

test("intercept is on by default for a hub, off for clients and when Claude Code is disabled", () => {
  expect(claudeInterceptEnabled({})).toBe(true);
  expect(claudeInterceptEnabled({ claudeCode: { intercept: { enabled: false } } })).toBe(false);
  expect(claudeInterceptEnabled({ claudeCode: { enabled: false } })).toBe(false);
  expect(claudeInterceptEnabled({ runtimeRole: "client" })).toBe(false);
  expect(claudeInterceptProxyPort({}, 8746)).toBe(8846);
  expect(claudeInterceptProxyPort({ claudeCode: { intercept: { port: 9100 } } }, 8746)).toBe(9100);
  expect(claudeInterceptProxyPort({ claudeCode: { intercept: { port: 0 } } }, 8746)).toBe(8846);
});

test("claudeCode.intercept is validated by the config schema", () => {
  const base = {
    port: 0, defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } },
  };
  expect(configSchema.safeParse({ ...base, claudeCode: { intercept: { enabled: false, port: 9100 } } }).success).toBe(true);
  expect(configSchema.safeParse({ ...base, claudeCode: { intercept: "off" } }).success).toBe(false);
  expect(configSchema.safeParse({ ...base, claudeCode: { intercept: { enabled: "no" } } }).success).toBe(false);
  expect(configSchema.safeParse({ ...base, claudeCode: { intercept: { port: 70000 } } }).success).toBe(false);
});

test("settings rollback restores managed values while preserving unrelated newer edits", () => {
  const configDir = dir();
  const previous = { HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: CA };
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: previous }));
  const rollback = captureClaudeInterceptSettingsRollback(env, configDir);
  expect(applyClaudeInterceptSettings(env, configDir).ok).toBe(true);
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ theme: "dark", env: { ...env, NEW: "kept" } }));
  expect(rollback()).toBe(true);
  expect(readSettings(configDir)).toEqual({ theme: "dark", env: { ...previous, NEW: "kept" } });
});

test("settings rollback refuses a newer managed proxy choice", () => {
  const configDir = dir();
  const rollback = captureClaudeInterceptSettingsRollback(env, configDir);
  applyClaudeInterceptSettings(env, configDir);
  const newer = { ...written, HTTPS_PROXY: "http://127.0.0.1:12000" };
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: newer }));
  expect(rollback()).toBe(false);
  expect(readSettings(configDir)).toEqual({ env: newer });
});

// #6936: loopback MCP servers must bypass the CONNECT-only intercept proxy.

test("apply merges the loopback bypass into a user NO_PROXY without duplicates", () => {
  const configDir = dir();
  seed(configDir, { env: { NO_PROXY: "localhost, .corp.example" } });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ env: { NO_PROXY: "localhost, .corp.example,127.0.0.1,::1", ...env } });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: false });
  expect(inspectClaudeInterceptSettings(env, configDir).kind).toBe("applied");

  // Every loopback entry already present, bracketed IPv6 included: nothing to add.
  const covered = dir();
  seed(covered, { env: { NO_PROXY: "LOCALHOST,[::1],127.0.0.1" } });
  applyClaudeInterceptSettings(env, covered);
  expect(readSettings(covered)).toEqual({ env: { NO_PROXY: "LOCALHOST,[::1],127.0.0.1", ...env } });
});

test("a NO_PROXY of * already bypasses loopback and is never rewritten or removed", () => {
  const configDir = dir();
  seed(configDir, { env: { NO_PROXY: "*" } });
  applyClaudeInterceptSettings(env, configDir);
  expect(readSettings(configDir)).toEqual({ env: { NO_PROXY: "*", ...env } });
  expect(inspectClaudeInterceptSettings(env, configDir).kind).toBe("applied");
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ env: { NO_PROXY: "*" } });
});

test("an owned block without the bypass is stale and the startup migrate repairs it", () => {
  const configDir = dir();
  seed(configDir, { env: { ...env, NO_PROXY: "10.0.0.5" } });
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "stale", env });
  expect(migrateClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ env: { ...env, NO_PROXY: `10.0.0.5,${LOOPBACK}` } });
  expect(inspectClaudeInterceptSettings(env, configDir).kind).toBe("applied");
});

test("a foreign proxy block never gains a NO_PROXY", () => {
  const configDir = dir();
  const foreign = { HTTPS_PROXY: "http://corp-proxy:3128", NODE_EXTRA_CA_CERTS: "/etc/corp/ca.pem" };
  seed(configDir, { env: foreign });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(migrateClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: false });
  expect(readSettings(configDir)).toEqual({ env: foreign });
});

test("remove strips only the appended loopback run and keeps the user's NO_PROXY key", () => {
  const configDir = dir();
  seed(configDir, { env: { FOO: "1", NO_PROXY: "localhost,.corp.example" } });
  applyClaudeInterceptSettings(env, configDir);
  expect(readSettings(configDir)).toMatchObject({ env: { NO_PROXY: "localhost,.corp.example,127.0.0.1,::1" } });
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ env: { FOO: "1", NO_PROXY: "localhost,.corp.example" } });

  // A key opencodex created goes away with the rest of the block.
  const created = dir();
  applyClaudeInterceptSettings(env, created);
  seed(created, { theme: "dark", env: { ...readSettings(created).env as object, FOO: "1" } });
  removeClaudeInterceptSettings(CA, created);
  expect(readSettings(created)).toEqual({ theme: "dark", env: { FOO: "1" } });
});

test("rollback restores the captured NO_PROXY unless the user changed it after the apply", () => {
  const created = dir();
  const rollbackCreated = captureClaudeInterceptSettingsRollback(env, created);
  applyClaudeInterceptSettings(env, created);
  expect(rollbackCreated()).toBe(true);
  expect(existsSync(join(created, "settings.json"))).toBe(true);
  expect(readSettings(created)).toEqual({});

  const merged = dir();
  seed(merged, { env: { NO_PROXY: ".corp.example" } });
  const rollbackMerged = captureClaudeInterceptSettingsRollback(env, merged);
  applyClaudeInterceptSettings(env, merged);
  expect(rollbackMerged()).toBe(true);
  expect(readSettings(merged)).toEqual({ env: { NO_PROXY: ".corp.example" } });

  const edited = dir();
  const rollbackEdited = captureClaudeInterceptSettingsRollback(env, edited);
  applyClaudeInterceptSettings(env, edited);
  seed(edited, { env: { ...env, NO_PROXY: `${LOOPBACK},mcp.internal` } });
  expect(rollbackEdited()).toBe(true);
  expect(readSettings(edited)).toEqual({ env: { NO_PROXY: `${LOOPBACK},mcp.internal` } });
});
