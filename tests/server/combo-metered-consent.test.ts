import { expect, test } from "bun:test";
import { loadConfig, saveConfig } from "../../src/config";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../../src/types";
import { admissionMayUseMeteredComboTargets } from "../../src/server/admission-model-scope";
import { parseComboTargets } from "../../src/cli/combo-input";
import { comboConfigError, normalizeComboConfig } from "../../src/combos";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const key = { id: "issued", name: "issued", key: "ocx_data_" + "a".repeat(40), createdAt: "2026-10-15T00:00:00Z" };
const admission = { kind: "configured", keyId: key.id, source: "bearer" } as const;

test("metered consent is literal true on a matching configured key", () => {
  for (const consent of [undefined, false, "true", 1, null, true]) {
    const config = { apiKeys: [{ ...key, allowMeteredComboTargets: consent }] } as OcxConfig;
    expect(admissionMayUseMeteredComboTargets(config, admission)).toBe(consent === true);
    expect(admissionMayUseMeteredComboTargets(config, { ...admission, keyId: "missing" })).toBe(false);
    expect(admissionMayUseMeteredComboTargets(config, undefined)).toBe(false);
    expect(admissionMayUseMeteredComboTargets(config, { kind: "loopback", source: "loopback" })).toBe(false);
    expect(admissionMayUseMeteredComboTargets(config, { kind: "environment", source: "bearer" })).toBe(false);
  }
});

test("CLI and combo normalization validate and preserve metered metadata", () => {
  const target = { provider: "a", model: "m", metered: true };
  expect(parseComboTargets([target])).toEqual([target]);
  expect(() => parseComboTargets([{ ...target, metered: "true" }])).toThrow();
  expect(comboConfigError("chain", { targets: [{ ...target, metered: "true" }] }, { a: { adapter: "openai-chat", baseUrl: "https://a.test/v1" } })).toContain("metered");
  expect(normalizeComboConfig({ targets: [target] }).targets[0]?.metered).toBe(true);
  expect(normalizeComboConfig({ targets: [{ provider: "a", model: "m" }] }).targets[0]?.metered).toBe(false);
});

test("metered metadata survives dashboard saves, explicit false clears it, malformed key consent is dropped", async () => {
  const previous = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-metered-consent-"));
  process.env.OPENCODEX_HOME = home;
  try {
    const config: OcxConfig = {
      port: 16389, defaultProvider: "a",
      providers: { a: { adapter: "openai-chat", baseUrl: "https://a.test/v1", models: ["m"] } },
      apiKeys: [{ ...key, allowMeteredComboTargets: true }],
    };
    saveConfig(config);
    expect(loadConfig().apiKeys?.[0]?.allowMeteredComboTargets).toBe(true);
    const put = async (target: unknown) => {
      const req = new ManagementRequest("http://localhost:16389/api/combos", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "chain", combo: { strategy: "failover", targets: [target] } }),
      });
      return handleManagementAPI(req, new URL(req.url), config, {
        createManagementConvergeCodex: catalogConvergenceFactory(async () => {}),
      });
    };
    expect((await put({ provider: "a", model: "m", metered: true }))?.status).toBe(200);
    expect((await put({ provider: " a ", model: " m " }))?.status).toBe(200);
    expect(config.combos?.chain?.targets[0]?.metered).toBe(true);
    const disk = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
    expect(disk().combos?.chain?.targets[0]?.metered).toBe(true);
    expect((await put({ provider: "a", model: "m", metered: "true" }))?.status).toBe(400);
    expect(disk().combos?.chain?.targets[0]?.metered).toBe(true);
    expect((await put({ provider: "a", model: "m", metered: false }))?.status).toBe(200);
    expect(disk().combos?.chain?.targets[0]).not.toHaveProperty("metered");
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, apiKeys: [{ ...key, allowMeteredComboTargets: "true" }] }));
    expect(loadConfig().apiKeys ?? []).toHaveLength(0);
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
});
