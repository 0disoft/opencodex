import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClientPathError } from "../../src/clients/client-path";
import { t3codeConfigPath } from "../../src/clients/config-export/t3code";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { readIntegrationState } from "../../src/integrations/state";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, refreshIntegration, restoreIntegration, type IntegrationWriteInput } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ocx-t3code-lifecycle-"));
  roots.push(home);
  const env = { T3CODE_HOME: "~/relocated-t3" };
  const path = join(home, "relocated-t3", "userdata", "settings.json");
  mkdirSync(dirname(path), { recursive: true });
  const original = { theme: "dark", providerInstances: { personal: { driver: "codex" } } };
  const before = JSON.stringify(original, null, 2) + "\n";
  writeFileSync(path, before);
  const input: IntegrationWriteInput = {
    clientId: "t3code", home, env, port: 10100,
    config: {
      port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
    } as OcxConfig,
    models: [{ namespaced: "mock/a", provider: "mock", id: "a" }],
    store: createIntegrationStateStore(join(home, "store")),
  };
  return { input, path, before, original };
}

test("T3CODE_HOME binds detection, apply and Undo to the same relocated file", () => {
  const f = fixture();
  expect(t3codeConfigPath(f.input.env, f.input.home)).toBe(f.path);
  expect(INTEGRATION_CLIENTS.t3code.detectDir(f.input.env, f.input.home)).toBe(dirname(f.path));
  expect(readIntegrationState(f.input)).toMatchObject({ state: "absent", installed: true, configPath: f.path });
  expect(applyIntegration(f.input)).toMatchObject({ ok: true, changed: true });
  expect(JSON.parse(readFileSync(f.path, "utf8")).providerInstances.personal).toEqual(f.original.providerInstances.personal);
  expect(existsSync(join(f.input.home!, ".t3", "userdata", "settings.json"))).toBe(false);
  const opId = f.input.store!.listOperations("t3code")[0]!.opId;
  expect(restoreIntegration({ ...f.input, opId }).ok).toBe(true);
  expect(readFileSync(f.path, "utf8")).toBe(f.before);
});

test("a bind change refuses refresh but retains classification and owned cleanup", () => {
  const f = fixture();
  expect(applyIntegration(f.input).ok).toBe(true);
  const applied = readFileSync(f.path, "utf8");
  const remote = { ...f.input, config: { ...f.input.config, hostname: "0.0.0.0" } };
  expect(readIntegrationState(remote).state).toBe("current");
  expect(refreshIntegration(remote)).toMatchObject({ ok: false, reason: "non_loopback" });
  expect(readFileSync(f.path, "utf8")).toBe(applied);
  expect(disableIntegration(remote).ok).toBe(true);
  expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual(f.original);
});

test("a relative T3CODE_HOME throws the shared leaf error before touching a file", () => {
  const f = fixture();
  expect(() => t3codeConfigPath({ T3CODE_HOME: "relative/t3" }, f.input.home)).toThrow(ClientPathError);
  expect(readFileSync(f.path, "utf8")).toBe(f.before);
});
