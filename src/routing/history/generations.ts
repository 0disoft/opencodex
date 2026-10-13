/**
 * Request-history index generations (#6990).
 *
 * Every full rebuild writes a private build file and publishes it under a
 * fresh, never-reused name; readers select the newest published name. No file
 * is renamed over an open database, and SQLite's `-wal`, `-shm` and
 * `-journal` names never collide between generations, so one process can
 * publish while another still reads an older generation.
 *
 * An older generation is reclaimed only once no initialized connection has it
 * open: SQLite refuses to switch a WAL database to rollback mode while any
 * other connection that has run a statement exists (idle or not, this process
 * or another), and the exclusive lock taken afterwards keeps late openers out
 * until the files are gone. A connection opened but not yet used is invisible
 * to that check; the indexer's own open verifies the file still exists after
 * its first statement and restarts the refresh when it was reclaimed.
 *
 * Leaving WAL mode checkpoints the whole `-wal` file in one statement, so a
 * serving process skips files whose WAL exceeds a small bound; a manual
 * rebuild (`ocx logs rebuild-index`, its own process) reclaims them.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

const GENERATION_FILE = /^g(\d{15}-\d+-\d+)\.sqlite$/;
const BUILD_ANY = /^b\d{15}-(\d+)-\d+\.sqlite(?:-wal|-shm|-journal)?$/;
const SQLITE_SIDE_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
/** Largest `-wal` a serving process checkpoints while reclaiming (~tens of ms). */
export const RECLAIM_SERVING_MAX_WAL_BYTES = 8 * 1024 * 1024;

let sequence = 0;

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Absolute path of the newest published generation, or null when none exists. */
export function newestGenerationPath(dir: string): string | null {
  let best: string | null = null;
  for (const name of listNames(dir)) {
    if (GENERATION_FILE.test(name) && (best === null || name > best)) best = name;
  }
  return best === null ? null : join(dir, best);
}

function generationMs(name: string): number {
  const id = GENERATION_FILE.exec(name)?.[1];
  return id === undefined ? -1 : Number(id.slice(0, 15));
}

/**
 * Private build path and a generation name. Readers pick the newest name by
 * string order, so the name sorts strictly above every generation already in
 * `dir`, even after the wall clock moved back or another machine's clock ran
 * ahead, and every field is zero-padded so digits compare in place. A rebuild
 * calls this again just before publishing and uses that generation name.
 */
export function newGenerationNames(dir: string, now = Date.now()): { buildPath: string; generationPath: string } {
  sequence += 1;
  let newestMs = -1;
  for (const name of listNames(dir)) newestMs = Math.max(newestMs, generationMs(name));
  const ms = Math.max(0, Math.trunc(now), newestMs + 1);
  const id = [
    String(ms).padStart(15, "0"),
    String(process.pid).padStart(10, "0"),
    String(sequence).padStart(10, "0"),
  ].join("-");
  return { buildPath: join(dir, `b${id}.sqlite`), generationPath: join(dir, `g${id}.sqlite`) };
}

function unlinkQuietly(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
}

/** Remove a private build this process owns; nobody else ever opens it. */
export function removeBuildFiles(path: string): void {
  unlinkQuietly(path);
  for (const suffix of SQLITE_SIDE_SUFFIXES) unlinkQuietly(`${path}${suffix}`);
}

/** removeBuildFiles, retried while Windows still reports a file in use after its last handle closed. */
export async function removeBuildFilesWithRetry(path: string, attempts = 5, delayMs = 200): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    removeBuildFiles(path);
    const left = [path, ...SQLITE_SIDE_SUFFIXES.map(suffix => `${path}${suffix}`)].some(file => existsSync(file));
    if (!left || attempt >= attempts) return;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** Remove build files whose owning process has exited. */
export function removeAbandonedBuilds(dir: string): void {
  for (const name of listNames(dir)) {
    const match = BUILD_ANY.exec(name);
    if (!match || processAlive(Number(match[1]))) continue;
    unlinkQuietly(join(dir, name));
  }
}

/**
 * Delete one published database only when no connection anywhere has it open.
 * Returns false when it is still in use, its WAL is above `maxWalBytes`, or
 * the attempt failed, so the caller retries after a later publication.
 */
export function reclaimDatabase(path: string, maxWalBytes: number): boolean {
  if (!existsSync(path)) return true;
  try {
    if (statSync(`${path}-wal`).size > maxWalBytes) return false;
  } catch {
    /* no WAL: nothing to checkpoint */
  }
  let handle: Database | null = null;
  try {
    handle = new Database(path, { readwrite: true });
    handle.exec("PRAGMA busy_timeout = 0");
    const mode = handle.query("PRAGMA journal_mode = DELETE").get() as { journal_mode?: string } | undefined;
    // Still WAL: another connection holds it open. Leave it for later.
    if (mode?.journal_mode !== "delete") return false;
    handle.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const busy = typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
    try { handle?.close(); } catch { /* already unusable */ }
    if (busy) return false;
    // Not a readable database at all: nobody can be using it as one.
    handle = null;
  }
  if (handle && process.platform === "win32") {
    // Windows cannot delete a file this process still holds open.
    try { handle.close(); } catch { /* already closed */ }
    handle = null;
  }
  let removed = unlinkQuietly(path);
  for (const suffix of SQLITE_SIDE_SUFFIXES) removed = unlinkQuietly(`${path}${suffix}`) && removed;
  if (handle) {
    try { handle.exec("ROLLBACK"); } catch { /* the lock goes with the handle */ }
    try { handle.close(); } catch { /* already closed */ }
  }
  return removed;
}

/** Published generations older than `keepPath`, oldest first. */
export function supersededGenerations(dir: string, keepPath: string): string[] {
  const keep = GENERATION_FILE.exec(basename(keepPath))?.[1];
  if (!keep) return [];
  return listNames(dir)
    .filter(name => {
      const id = GENERATION_FILE.exec(name)?.[1];
      return id !== undefined && id < keep;
    })
    .sort()
    .map(name => join(dir, name));
}
