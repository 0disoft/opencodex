/**
 * Every role model write the omo tab and `ocx agent roles set` make, so a role can be put back.
 * The integration journal cannot hold these: it snapshots one client config per operation, and a
 * role write spans `$CODEX_HOME/agents/<role>.toml` and LazyCodex's omo.jsonc mirror. So the
 * values are recorded rather than bytes, and a restore is an ordinary write of the earlier values.
 * Writes made in one action (auto-assign's Apply all) share a batch and are restored together.
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

export const ROLE_HISTORY_LIMIT = 50;
const BATCH_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function historyPath(dir: string): string {
  return join(dir, "codex-agent-roles.jsonl");
}

export function isRoleHistoryBatch(value: unknown): value is string {
  return typeof value === "string" && BATCH_PATTERN.test(value);
}

export function recordRoleModelChange(change: RoleModelChange, dir: string = integrationsDir()): void {
  ensureDir(historyPath(dir));
  appendFileSync(historyPath(dir), `${JSON.stringify(change)}\n`, { encoding: "utf8", mode: 0o600 });
}

function isSetting(value: unknown): value is RoleSetting {
  const setting = value as RoleSetting | null;
  return typeof setting === "object" && setting !== null
    && (setting.model === null || typeof setting.model === "string")
    && (setting.effort === null || typeof setting.effort === "string");
}

function parseChange(line: string): RoleModelChange | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const change = value as RoleModelChange | null;
  return typeof change === "object" && change !== null && typeof change.at === "string" && typeof change.role === "string"
    && isRoleHistoryBatch(change.batch) && isSetting(change.before) && isSetting(change.after)
    ? change
    : null;
}

/**
 * Newest first, in whole batches: the newest `limit` changes plus the rest of any batch they cut into,
 * so Restore never puts back part of an Apply all. A torn or foreign line is skipped, the way the
 * integration journal reads its own.
 */
export function listRoleModelChanges(limit: number = ROLE_HISTORY_LIMIT, dir: string = integrationsDir()): RoleModelChange[] {
  const path = historyPath(dir);
  if (!existsSync(path)) return [];
  const newestFirst = readFileSync(path, "utf8").split("\n").flatMap(line => {
    const change = line.trim() ? parseChange(line) : null;
    return change ? [change] : [];
  }).reverse();
  const kept = new Set(newestFirst.slice(0, limit).map(change => change.batch));
  return newestFirst.filter((change, index) => index < limit || kept.has(change.batch));
}
