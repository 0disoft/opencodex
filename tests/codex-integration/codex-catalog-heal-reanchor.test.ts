import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCatalogHealPaths } from "../../src/codex/catalog/heal-observation";
import { startCodexCatalogSelfHeal } from "../../src/codex/catalog-self-heal";
import type { CatalogPublicationEvent } from "../../src/codex/catalog/publication-observer";
import type { OcxConfig } from "../../src/types";

const roots: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(join(tmpdir(), "ocx-heal-reanchor-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("a leaf symlink retargeted before native resolution stays unknown on every platform", () => {
  const root = fixture(), a = join(root, "a.json"), b = join(root, "b.json"), alias = join(root, "alias.json");
  fs.writeFileSync(a, "A");
  fs.writeFileSync(b, "B");
  fs.symlinkSync(a, alias, "file");
  const native = fs.realpathSync.native;
  let swapped = false;
  const spy = spyOn(fs.realpathSync, "native").mockImplementation((path, options) => {
    if (!swapped) {
      swapped = true;
      fs.unlinkSync(alias);
      fs.symlinkSync(b, alias, "file");
    }
    return native(path, options);
  });
  let relation;
  try { relation = compareCatalogHealPaths(alias, a); }
  finally { spy.mockRestore(); }
  expect(swapped).toBe(true);
  expect(native(alias)).toBe(native(b));
  expect(fs.readFileSync(alias, "utf8")).toBe("B");
  expect(relation).toBe("unknown");
});

test("a proven selected publication reanchors when the obsolete target is a dangling symlink", async () => {
  const root = fixture(), oldPath = join(root, "old.json"), newPath = join(root, "new.json");
  const full = { models: [{ slug: "ark/a", description: "Routed via opencodex → ark/a (owner)." }] };
  fs.writeFileSync(oldPath, JSON.stringify(full));
  fs.writeFileSync(newPath, JSON.stringify(full));
  let selected = oldPath;
  let listener: (event: CatalogPublicationEvent) => void = () => {};
  let converges = 0;
  const config = { port: 10100, defaultProvider: "ark", providers: {
    ark: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
  } } as OcxConfig;
  const handle = startCodexCatalogSelfHeal({ deps: {
    scheduleFn: () => ({ cancel() {} }), catalogPath: () => selected,
    subscribe: fn => { listener = fn; return () => {}; },
    converge: async (_config, lifecycle) => {
      converges++;
      expect(lifecycle.expectedCatalogPath).toBe(newPath);
      expect(lifecycle.beforeCommit()).toBe(true);
      return { committed: false };
    },
    gates: { siblingOfLivePort: () => null, exiting: () => false, idle: () => true,
      runtimeOwned: () => true, loadConfig: () => config,
      ownsCodexHome: () => true, clientConnected: () => false, clientJournalOwner: () => false },
    log: { warn() {} },
  } });
  try {
    fs.renameSync(oldPath, join(root, "saved-old.json"));
    fs.symlinkSync(join(root, "missing.json"), oldPath, "file");
    selected = newPath;
    expect(compareCatalogHealPaths(oldPath, newPath)).toBe("unknown");
    expect(compareCatalogHealPaths(newPath, newPath)).toBe("same");
    listener({ kind: "published", path: newPath, intent: "refresh" });
    fs.writeFileSync(newPath, JSON.stringify({ models: [] }));
    for (let i = 0; i < 3; i++) await handle.tickForTests();
    expect(converges).toBe(1);
  } finally { handle.stop(); }
});
