import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ROLE = 'name = "explorer"\ndeveloper_instructions = """\nmodel = "x"\n"""\nmodel = "gpt-5.5"\n';
const saved = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, OPENCODEX_HOME: process.env.OPENCODEX_HOME };
let root = "";

function restore(name: keyof typeof saved): void {
  if (saved[name] === undefined) delete process.env[name];
  else process.env[name] = saved[name];
}

beforeEach(() => {
  // Match getCodexHome(), which resolves aliases before filesystem access (for example macOS /var).
  root = fs.realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-agent-role-routes-")));
  mkdirSync(join(root, "codex", "agents"), { recursive: true });
  mkdirSync(join(root, "home", ".omo"), { recursive: true });
  writeFileSync(join(root, "codex", "agents", "explorer.toml"), ROLE);
  installLazyCodex();
  process.env.CODEX_HOME = join(root, "codex");
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  process.env.OPENCODEX_HOME = join(root, "ocx");
});

afterEach(() => {
  restore("CODEX_HOME");
  restore("HOME");
  restore("USERPROFILE");
  restore("OPENCODEX_HOME");
  removeTreeWithRetry(root);
});

const config = { port: 10100, providers: {}, defaultProvider: "openai" } as unknown as OcxConfig;
const DETECTED = { detected: true, pluginEnabled: true, pluginInstalled: true };

function installLazyCodex(home = join(root, "codex")): void {
  const plugin = join(home, "plugins", "cache", "sisyphuslabs", "omo", "5.1.1");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "lazycodex-install.json"), "{}");
  writeFileSync(join(home, "config.toml"), '[plugins."omo@sisyphuslabs"]\nenabled = true\n');
}

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleManagementAPI(new Request(`http://localhost${path}`, init), new URL(`http://localhost${path}`), config);
  expect(response).not.toBeNull();
  return { status: response!.status, body: await response!.json() as Record<string, unknown> };
}

function put(role: string, model: unknown) {
  return call(`/api/codex-agent-roles/${role}`, { method: "PUT", body: JSON.stringify({ model }) });
}

describe("/api/codex-agent-roles", () => {
  test("lists and restores only the history of the Codex home the proxy runs against", async () => {
    const homeA = join(root, "codex");
    const homeB = join(root, "codex-b");
    mkdirSync(join(homeB, "agents"), { recursive: true });
    writeFileSync(join(homeB, "agents", "explorer.toml"), ROLE);
    installLazyCodex(homeB);
    const write = (body: Record<string, unknown>) => call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify(body) });
    expect((await write({ model: "xai/grok-4.5", batch: "home-a" })).status).toBe(200);
    const restore = { model: "gpt-5.5", effort: null, batch: "restore-1", restores: "home-a" };

    // The proxy restarts against a second home with a role of the same name.
    process.env.CODEX_HOME = homeB;
    expect((await call("/api/codex-agent-roles")).body.history).toEqual([]);
    expect(await write(restore)).toMatchObject({ status: 409, body: { code: "restore_not_in_history" } });
    expect(readFileSync(join(homeB, "agents", "explorer.toml"), "utf8")).toBe(ROLE);

    process.env.CODEX_HOME = homeA;
    const history = (await call("/api/codex-agent-roles")).body.history as Array<Record<string, unknown>>;
    expect(history.map(change => change.batch)).toEqual(["home-a"]);
    expect(history[0]).not.toHaveProperty("codexHome");
    expect(await write({ ...restore, model: "a/other" })).toMatchObject({ status: 409, body: { code: "restore_not_in_history" } });
    expect((await write(restore)).status).toBe(200);
    expect(readFileSync(join(homeA, "agents", "explorer.toml"), "utf8")).toBe(ROLE);
  });

  function historyRow(batch: string, role: string, model = "m"): import("../../src/codex/role-model-history").RoleModelChange {
    return { at: "2026-10-24T00:00:00.000Z", batch, role, before: { model: null, effort: null }, after: { model, effort: null } };
  }

  test("lists whole batches and never more than 50 rows, even when one batch id was reused past its cap", async () => {
    const { listRoleModelChanges, recordRoleModelChange, ROLE_HISTORY_LIMIT } = await import("../../src/codex/role-model-history");
    const dir = join(root, "history");
    for (let index = 0; index < 30; index++) recordRoleModelChange("home", historyRow("a", `a-${index}`), dir);
    for (let index = 0; index < 30; index++) recordRoleModelChange("home", historyRow("b", `b-${index}`), dir);
    expect(listRoleModelChanges("home", ROLE_HISTORY_LIMIT, dir).map(change => change.batch)).toEqual(Array(30).fill("b"));
    // A file written before the batch cap can hold one batch larger than the whole response.
    for (let index = 0; index < 120; index++) recordRoleModelChange("home", historyRow("reused", `r-${index}`), dir);
    const history = listRoleModelChanges("home", ROLE_HISTORY_LIMIT, dir);
    expect(history.length).toBeLessThanOrEqual(ROLE_HISTORY_LIMIT);
    expect(history.map(change => change.batch)).toEqual(Array(30).fill("b"));
  });

  test("a write into a batch that already holds 50 rows is refused before the role file changes", async () => {
    const { recordRoleModelChange, ROLE_HISTORY_LIMIT } = await import("../../src/codex/role-model-history");
    const dir = join(root, "ocx", "integrations");
    for (let index = 0; index < ROLE_HISTORY_LIMIT; index++) recordRoleModelChange(join(root, "codex"), historyRow("full", `role-${index}`), dir);
    const refused = await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "xai/grok-4.5", batch: "full" }) });
    expect(refused).toMatchObject({ status: 409, body: { code: "batch_full" } });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toBe(ROLE);
    expect((await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "xai/grok-4.5", batch: "next" }) })).status).toBe(200);
  });

  test("keeps the history file within its byte budget by dropping the oldest whole batches", async () => {
    const { listRoleModelChanges, recordRoleModelChange, ROLE_HISTORY_MAX_BYTES } = await import("../../src/codex/role-model-history");
    const dir = join(root, "history");
    const wide = "m".repeat(4000);
    let batches = 0;
    for (let written = 0; written < ROLE_HISTORY_MAX_BYTES * 3; written += 3 * wide.length, batches += 1) {
      for (let role = 0; role < 3; role++) recordRoleModelChange("home", historyRow(`batch-${batches}`, `role-${role}`, wide), dir);
    }
    const path = join(dir, "codex-agent-roles.jsonl");
    expect(fs.statSync(path).size).toBeLessThanOrEqual(ROLE_HISTORY_MAX_BYTES);
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { batch: string });
    const sizes = new Map<string, number>();
    for (const row of rows) sizes.set(row.batch, (sizes.get(row.batch) ?? 0) + 1);
    expect([...sizes.values()].every(size => size === 3)).toBe(true);
    expect(rows.at(-1)!.batch).toBe(`batch-${batches - 1}`);
    expect(sizes.has("batch-0")).toBe(false);
    expect(listRoleModelChanges("home", 50, dir)[0]!.batch).toBe(`batch-${batches - 1}`);
  });

  test("reads only the tail of an oversized history file", async () => {
    const { listRoleModelChanges, ROLE_HISTORY_MAX_BYTES } = await import("../../src/codex/role-model-history");
    const dir = join(root, "history");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "codex-agent-roles.jsonl");
    const line = (batch: string, role: string) => `${JSON.stringify({ ...historyRow(batch, role), codexHome: "home" })}\n`;
    // An oversized file from before retention, or one a failed compaction left behind.
    writeFileSync(path, line("ancient", "explorer").repeat(Math.ceil((ROLE_HISTORY_MAX_BYTES * 4) / line("ancient", "explorer").length)) + line("newest", "explorer"));
    const nativeReadFile = fs.readFileSync;
    const nativeRead = fs.readSync;
    let wholeReads = 0;
    let bytesRead = 0;
    const readFile = spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(target) === path) wholeReads += 1;
      return nativeReadFile(target, options as BufferEncoding);
    }) as never);
    const read = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = (nativeRead as (...rest: unknown[]) => number)(...args);
      bytesRead += count;
      return count;
    }) as never);
    try {
      expect(listRoleModelChanges("home", 50, dir)[0]!.batch).toBe("newest");
    } finally {
      readFile.mockRestore();
      read.mockRestore();
    }
    expect(wholeReads).toBe(0);
    expect(bytesRead).toBeLessThanOrEqual(ROLE_HISTORY_MAX_BYTES + 1);
  });

  test("an unreadable history file leaves the role list and role saves working", async () => {
    // A directory where the history file belongs makes every read of it fail (EISDIR) on every platform.
    mkdirSync(join(root, "ocx", "integrations", "codex-agent-roles.jsonl"), { recursive: true });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const listed = await call("/api/codex-agent-roles");
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ roles: [{ role: "explorer", model: "gpt-5.5" }], history: [], historyUnavailable: true });
      expect((await put("explorer", "xai/grok-4.5")).status).toBe(200);
      expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toContain('model = "xai/grok-4.5"');
    } finally {
      error.mockRestore();
    }
  });

  test("records each written change with its earlier values, newest first, and skips an unchanged save", async () => {
    const write = (body: Record<string, unknown>) => call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify(body) });
    expect((await write({ model: "xai/grok-4.5", effort: "high", batch: "apply-all-1" })).status).toBe(200);
    expect((await write({ model: "xai/grok-4.5", effort: "high", batch: "apply-all-2" })).body).toMatchObject({ toml: { status: "unchanged" } });
    await write({ effort: null });
    const history = (await call("/api/codex-agent-roles")).body.history as Record<string, unknown>[];
    expect(history.map(({ batch, role, before, after }) => ({ batch, role, before, after }))).toEqual([
      { batch: expect.stringMatching(/^[0-9a-f-]{36}$/), role: "explorer", before: { model: "xai/grok-4.5", effort: "high" }, after: { model: "xai/grok-4.5", effort: null } },
      { batch: "apply-all-1", role: "explorer", before: { model: "gpt-5.5", effort: null }, after: { model: "xai/grok-4.5", effort: "high" } },
    ]);
    const refused = await write({ model: "gpt-5.5", batch: "../x" });
    expect(refused).toMatchObject({ status: 400, body: { code: "invalid_batch" } });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toContain('model = "xai/grok-4.5"');
  });

  test("round-trips a role model through the TOML and omo.jsonc", async () => {
    writeFileSync(join(root, "home", ".omo", "omo.jsonc"), '{ "[codex]": {} }\n');
    expect((await call("/api/codex-agent-roles")).body).toEqual({
      lazycodex: DETECTED,
      omoJsonc: { state: "present" },
      roles: [{ role: "explorer", model: "gpt-5.5", effort: null, omoJsoncModel: null }],
      history: [],
    });
    const saved = await put("explorer", "xai/grok-4.5");
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ok: true, role: "explorer", model: "xai/grok-4.5", toml: { status: "written" }, omoJsonc: { status: "written" } });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toBe(ROLE.replace('model = "gpt-5.5"', 'model = "xai/grok-4.5"'));
    expect((await call("/api/codex-agent-roles")).body.roles).toEqual([{ role: "explorer", model: "xai/grok-4.5", effort: null, omoJsoncModel: "xai/grok-4.5" }]);
  });

  test("an effort goes to the role file and, as reasoning, to omo.jsonc", async () => {
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": { "agents": { "explorer": { "model": "gpt-5.5", "reasoning": "low" } } } }\n');
    const saved = await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "gpt-5.5", effort: "high" }) });
    expect(saved.body).toMatchObject({ effort: "high", toml: { status: "written" }, omoJsonc: { status: "written" } });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toContain('model_reasoning_effort = "high"');
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.explorer).toEqual({ model: "gpt-5.5", reasoning: "high" });
    expect((await call("/api/codex-agent-roles")).body.roles).toEqual([{ role: "explorer", model: "gpt-5.5", effort: "high", omoJsoncModel: "gpt-5.5" }]);

    // LazyCodex has no ultra level: the role file keeps it, and omo.jsonc drops the stale low.
    await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "gpt-5.5", effort: "ultra" }) });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toContain('model_reasoning_effort = "ultra"');
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.explorer).toEqual({ model: "gpt-5.5" });
  });

  test("a null effort removes the role-level effort override from both files", async () => {
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": { "agents": { "explorer": { "model": "gpt-5.5", "reasoning": "high", "temperature": 0.2 } } } }\n');
    await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "gpt-5.5", effort: "high" }) });
    const cleared = await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "gpt-5.5", effort: null }) });
    expect(cleared.body).toMatchObject({ effort: null, toml: { status: "written" }, omoJsonc: { status: "written" } });
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).not.toContain("model_reasoning_effort");
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.explorer).toEqual({ model: "gpt-5.5", temperature: 0.2 });
    expect((await call("/api/codex-agent-roles")).body.roles).toEqual([{ role: "explorer", model: "gpt-5.5", effort: null, omoJsoncModel: "gpt-5.5" }]);
  });

  test.each([
    ["multiline basic", '"""\nhigh\n"""'],
    ["multiline literal", "'''\nhigh\n'''"],
    ["non-string", "5"],
  ])("clearing a %s effort returns 409 and leaves both files unchanged", async (_kind, value) => {
    const rolePath = join(root, "codex", "agents", "explorer.toml");
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(rolePath, ROLE + `model_reasoning_effort = ${value}\n`);
    writeFileSync(omoPath, '{ "[codex]": { "agents": { "explorer": { "model": "gpt-5.5", "reasoning": "high" } } } }\n');
    const roleBefore = readFileSync(rolePath);
    const omoBefore = readFileSync(omoPath);
    const refused = await call("/api/codex-agent-roles/explorer", {
      method: "PUT", body: JSON.stringify({ model: "xai/grok-4.5", effort: null }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("unsupported_model_value");
    expect(readFileSync(rolePath)).toEqual(roleBefore);
    expect(readFileSync(omoPath)).toEqual(omoBefore);
  });

  test("a model-only save keeps the role's effort and its omo.jsonc reasoning", async () => {
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": { "agents": { "explorer": { "model": "gpt-5.5", "reasoning": "high" } } } }\n');
    await call("/api/codex-agent-roles/explorer", { method: "PUT", body: JSON.stringify({ model: "gpt-5.5", effort: "high" }) });
    const saved = await put("explorer", "xai/grok-4.5");
    expect(saved.status).toBe(200);
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toContain('model_reasoning_effort = "high"');
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.explorer).toEqual({ model: "xai/grok-4.5", reasoning: "high" });
  });

  // librarian has no root model pin: Codex gives it the model the parent spawns it with.
  const INHERITING = 'name = "librarian"\ndeveloper_instructions = """\nmodel = "x"\n"""\n';

  function inheritingRole(content = INHERITING): string {
    const path = join(root, "codex", "agents", "librarian.toml");
    writeFileSync(path, content);
    return path;
  }

  function roleCall(role: string, body: unknown) {
    return call(`/api/codex-agent-roles/${role}`, { method: "PUT", body: JSON.stringify(body) });
  }

  test("an effort-only save sets and clears a model-inheriting role's effort in both files without pinning a model", async () => {
    const rolePath = inheritingRole();
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": { "agents": { "librarian": { "model": "omo/pick", "temperature": 0.2 } } } }\n');
    const set = await roleCall("librarian", { effort: "high" });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ ok: true, role: "librarian", effort: "high", toml: { status: "written" }, omoJsonc: { status: "written" } });
    expect(readFileSync(rolePath, "utf8")).toBe(`model_reasoning_effort = "high"\n${INHERITING}`);
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.librarian).toEqual({ model: "omo/pick", temperature: 0.2, reasoning: "high" });
    const listed = (await call("/api/codex-agent-roles")).body.roles as Array<Record<string, unknown>>;
    expect(listed.find(row => row.role === "librarian")).toEqual({ role: "librarian", model: null, effort: "high", omoJsoncModel: "omo/pick" });

    const repeated = await roleCall("librarian", { effort: "high" });
    expect(repeated.body).toMatchObject({ toml: { status: "unchanged" }, omoJsonc: { status: "unchanged" } });

    const changed = await roleCall("librarian", { effort: "low" });
    expect(changed.body).toMatchObject({ effort: "low", toml: { status: "written" }, omoJsonc: { status: "written" } });
    expect(readFileSync(rolePath, "utf8")).toBe(`model_reasoning_effort = "low"\n${INHERITING}`);

    const cleared = await roleCall("librarian", { effort: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ ok: true, role: "librarian", effort: null, toml: { status: "written" }, omoJsonc: { status: "written" } });
    expect(readFileSync(rolePath, "utf8")).toBe(INHERITING);
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.librarian).toEqual({ model: "omo/pick", temperature: 0.2 });
  });

  test("an effort-only save maps efforts for LazyCodex and creates an omo.jsonc entry only to hold one", async () => {
    inheritingRole();
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": {} }\n');
    // LazyCodex has no ultra level, and there is no stale reasoning to remove: the file is not rewritten.
    expect((await roleCall("librarian", { effort: "ultra" })).body).toMatchObject({ toml: { status: "written" }, omoJsonc: { status: "unchanged" } });
    expect(readFileSync(omoPath, "utf8")).toBe('{ "[codex]": {} }\n');
    expect((await roleCall("librarian", { effort: "none" })).body.omoJsonc).toEqual({ status: "written" });
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.librarian).toEqual({ reasoning: "off" });
  });

  test("a body with neither a model nor an effort, or a null model, is refused without touching either file", async () => {
    const rolePath = inheritingRole(`model_reasoning_effort = "high"\n${INHERITING}`);
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": { "agents": { "librarian": { "reasoning": "high" } } } }\n');
    const roleBefore = readFileSync(rolePath);
    const omoBefore = readFileSync(omoPath);
    for (const body of [{}, null]) {
      const refused = await roleCall("librarian", body);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("empty_update");
    }
    for (const body of [{ model: null }, { model: null, effort: "low" }]) {
      const refused = await roleCall("librarian", body);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("invalid_model");
    }
    const badEffort = await roleCall("librarian", { effort: "turbo" });
    expect(badEffort.status).toBe(400);
    expect(badEffort.body.code).toBe("invalid_effort");
    expect((await roleCall("missing", { effort: "low" })).status).toBe(404);
    expect(readFileSync(rolePath)).toEqual(roleBefore);
    expect(readFileSync(omoPath)).toEqual(omoBefore);
  });

  test("a model-only save of a model-inheriting role pins the model and keeps its effort", async () => {
    const rolePath = inheritingRole(`model_reasoning_effort = "high"\n${INHERITING}`);
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": { "agents": { "librarian": { "reasoning": "high" } } } }\n');
    const saved = await put("librarian", "xai/grok-4.5");
    expect(saved.body).toEqual({ ok: true, role: "librarian", model: "xai/grok-4.5", toml: { status: "written" }, omoJsonc: { status: "written" } });
    expect(readFileSync(rolePath, "utf8")).toBe(`model = "xai/grok-4.5"\nmodel_reasoning_effort = "high"\n${INHERITING}`);
    expect(JSON.parse(readFileSync(omoPath, "utf8"))["[codex]"].agents.librarian).toEqual({ model: "xai/grok-4.5", reasoning: "high" });
  });


  test("without LazyCodex it lists nothing, writes nothing, and never opens omo.jsonc", async () => {
    writeFileSync(join(root, "codex", "config.toml"), "");
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": {} }\n');
    const nativeRead = fs.readFileSync;
    const reads: string[] = [];
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
      reads.push(String(path));
      return nativeRead(path, options as BufferEncoding);
    }) as never);
    try {
      expect((await call("/api/codex-agent-roles")).body).toEqual({
        lazycodex: { detected: false, pluginEnabled: false, pluginInstalled: true },
        omoJsonc: null,
        roles: [],
      });
      const refused = await put("explorer", "m");
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("lazycodex_not_detected");
    } finally {
      spy.mockRestore();
    }
    expect(reads).not.toContain(omoPath);
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toBe(ROLE);
    expect(readFileSync(omoPath, "utf8")).toBe('{ "[codex]": {} }\n');
  });

  test("reports an absent or commented omo.jsonc without writing it", async () => {
    expect((await put("explorer", "m1")).body.omoJsonc).toEqual({ status: "absent" });
    const commented = '{ // mine\n  "codex": {} }\n';
    writeFileSync(join(root, "home", ".omo", "omo.jsonc"), commented);
    expect((await call("/api/codex-agent-roles")).body.omoJsonc).toEqual({ state: "comments" });
    const result = await put("explorer", "m2");
    expect(result.body.toml).toEqual({ status: "written" });
    expect(result.body.omoJsonc).toEqual({ status: "skipped_comments" });
    expect(readFileSync(join(root, "home", ".omo", "omo.jsonc"), "utf8")).toBe(commented);
  });

  test("rejects unknown roles, traversal, and bad models", async () => {
    expect((await put("missing", "m")).status).toBe(404);
    expect((await put("..%2Fconfig", "m")).status).toBe(404);
    expect((await put("%E0%A4%A", "m")).status).toBe(400);
    expect((await put("explorer", "")).status).toBe(400);
    expect((await put("explorer", 7)).status).toBe(400);
    expect(readFileSync(join(root, "codex", "agents", "explorer.toml"), "utf8")).toBe(ROLE);
  });

  test("an unreadable omo.jsonc still lists the roles", async () => {
    const omoPath = join(root, "home", ".omo", "omo.jsonc");
    writeFileSync(omoPath, '{ "[codex]": {} }\n');
    const nativeOpen = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((path, flags, mode) => {
      if (path === omoPath) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return nativeOpen(path, flags, mode);
    }) as typeof fs.openSync);
    try {
      const listed = await call("/api/codex-agent-roles");
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual({
        lazycodex: DETECTED,
        omoJsonc: { state: "unreadable" },
        roles: [{ role: "explorer", model: "gpt-5.5", effort: null, omoJsoncModel: null }],
        history: [],
      });
      const saved = await put("explorer", "m3");
      expect(saved.body.toml).toEqual({ status: "written" });
      expect(saved.body.omoJsonc).toEqual({ status: "write_failed" });
    } finally {
      spy.mockRestore();
    }
  });

  test("refuses an invalid role file with 409 and keeps it unchanged", async () => {
    const rolePath = join(root, "codex", "agents", "explorer.toml");
    const broken = 'name = "explorer"\nmodel = "old\\q"\n';
    writeFileSync(rolePath, broken);
    const refused = await put("explorer", "m4");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("invalid_role_file");
    expect(readFileSync(rolePath, "utf8")).toBe(broken);
  });

  test("a filesystem failure is reported without its path", async () => {
    // getCodexHome() canonicalizes CODEX_HOME, so the route reads the real path. On macOS the
    // temp root sits under /var, a symlink to /private/var: matching the spelled path would never
    // fire, the write would succeed, and the test would prove nothing about the failure branch.
    const canonicalRoot = realpathSync.native(root);
    const rolePath = join(canonicalRoot, "codex", "agents", "explorer.toml");
    const nativeRead = fs.readFileSync;
    let denied = 0;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
      if (path === rolePath) {
        denied += 1;
        throw Object.assign(new Error(`EACCES: permission denied, open '${rolePath}'`), { code: "EACCES" });
      }
      return nativeRead(path, options as BufferEncoding);
    }) as never);
    try {
      const failed = await put("explorer", "m5");
      expect(denied).toBeGreaterThan(0);
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ error: "could not write the role file", code: "write_failed" });
      expect(JSON.stringify(failed.body)).not.toContain(root);
      expect(JSON.stringify(failed.body)).not.toContain(canonicalRoot);
    } finally {
      spy.mockRestore();
    }
  });
});
