/**
 * Every role model write the omo tab and `ocx agent roles set` make, so a role can be put back.
 * The integration journal cannot hold these: it snapshots one client config per operation, and a
 * role write spans `$CODEX_HOME/agents/<role>.toml` and LazyCodex's omo.jsonc mirror. So the
 * values are recorded rather than bytes, and a restore is an ordinary write of the earlier values.
 * Writes made in one action (auto-assign's Apply all) share a batch and are restored together.
 * The file sits under the opencodex config directory, which outlives a switch of Codex home, so every
 * row names the canonical Codex home it was written in and only that home's rows are listed or restored.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, integrationsDir } from "../integrations/ownership";

export interface RoleSetting {
  readonly model: string | null;
  readonly effort: string | null;
}

export interface RoleModelChange {
  readonly at: string;
  readonly batch: string;
  readonly role: string;
  readonly before: RoleSetting;
  readonly after: RoleSetting;
}

interface StoredRoleModelChange extends RoleModelChange {
  readonly codexHome: string;
}

export const ROLE_HISTORY_LIMIT = 50;
const BATCH_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function historyPath(dir: string): string {
  return join(dir, "codex-agent-roles.jsonl");
}

export function isRoleHistoryBatch(value: unknown): value is string {
  return typeof value === "string" && BATCH_PATTERN.test(value);
}

/** `codexHome` is the canonical path `getCodexHome()` returns, so two spellings of one home match. */
export function recordRoleModelChange(codexHome: string, change: RoleModelChange, dir: string = integrationsDir()): void {
  ensureDir(historyPath(dir));
  const stored: StoredRoleModelChange = { ...change, codexHome };
  appendFileSync(historyPath(dir), `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
}

function isSetting(value: unknown): value is RoleSetting {
  const setting = value as RoleSetting | null;
  return typeof setting === "object" && setting !== null
    && (setting.model === null || typeof setting.model === "string")
    && (setting.effort === null || typeof setting.effort === "string");
}

function parseChange(line: string, codexHome: string): RoleModelChange | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const change = value as StoredRoleModelChange | null;
  return typeof change === "object" && change !== null && change.codexHome === codexHome
    && typeof change.at === "string" && typeof change.role === "string"
    && isRoleHistoryBatch(change.batch) && isSetting(change.before) && isSetting(change.after)
    ? { at: change.at, batch: change.batch, role: change.role, before: change.before, after: change.after }
    : null;
}

/**
 * This Codex home's changes, newest first, in whole batches: the newest `limit` changes plus the rest
 * of any batch they cut into, so Restore never puts back part of an Apply all. A torn or foreign line,
 * and a row another Codex home wrote, is skipped, the way the integration journal reads its own.
 */
export function listRoleModelChanges(codexHome: string, limit: number = ROLE_HISTORY_LIMIT, dir: string = integrationsDir()): RoleModelChange[] {
  const path = historyPath(dir);
  if (!existsSync(path)) return [];
  const newestFirst = readFileSync(path, "utf8").split("\n").flatMap(line => {
    const change = line.trim() ? parseChange(line, codexHome) : null;
    return change ? [change] : [];
  }).reverse();
  const kept = new Set(newestFirst.slice(0, limit).map(change => change.batch));
  return newestFirst.filter((change, index) => index < limit || kept.has(change.batch));
}

/**
 * The setting a Restore of `batch` may put back on `role` in this Codex home: the role's earliest
 * `before` in that batch, or null when this home's listed history has no such change. The server
 * checks a restore against it, so a dashboard still showing another home's history cannot write
 * that home's earlier models here.
 */
export function restorableSetting(codexHome: string, batch: string, role: string, dir: string = integrationsDir()): RoleSetting | null {
  const changes = listRoleModelChanges(codexHome, ROLE_HISTORY_LIMIT, dir).filter(change => change.batch === batch && change.role === role);
  return changes.at(-1)?.before ?? null;
}
