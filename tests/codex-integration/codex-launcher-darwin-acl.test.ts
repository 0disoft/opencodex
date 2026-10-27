import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ownership from "../../src/cli/codex-launch-ownership";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("Codex launcher Darwin ACL mutation admission", () => {
  test("empty ACLs are safe", () => {
    expect(ownership.darwinAclEntriesAreSafe([])).toBe(true);
  });
  test("deny-only ACLs are safe", () => {
    expect(ownership.darwinAclEntriesAreSafe([{ tag: 2, perms: 0xffffffff }])).toBe(true);
  });
  test("read-only allow ACLs are safe", () => {
    expect(ownership.darwinAclEntriesAreSafe([{ tag: 1, perms: (1 << 1) | (1 << 3) | (1 << 7) | (1 << 9) | (1 << 11) | (1 << 20) }])).toBe(true);
  });

  // Apple sys/acl.h: aliases ADD_FILE/ADD_SUBDIRECTORY share WRITE_DATA/APPEND_DATA bits.
  for (const [name, bit] of [
    ["WRITE_DATA / ADD_FILE", 2], ["DELETE", 4], ["APPEND_DATA / ADD_SUBDIRECTORY", 5],
    ["DELETE_CHILD", 6], ["WRITE_ATTRIBUTES", 8], ["WRITE_EXTATTRIBUTES", 10],
    ["WRITE_SECURITY", 12], ["CHANGE_OWNER", 13],
  ] as const) {
    test(`allow ${name} refuses`, () => {
      expect(ownership.darwinAclEntriesAreSafe([{ tag: 1, perms: 1 << bit }])).toBe(false);
    });
  }

  test("a deny entry cannot hide a subsequent mutating allow", () => {
    expect(ownership.darwinAclEntriesAreSafe([{ tag: 2, perms: 1 << 2 }, { tag: 1, perms: 1 << 2 }])).toBe(false);
  });

  test("unknown tags and incomplete enumeration refuse", () => {
    expect(ownership.darwinAclEntriesAreSafe([{ tag: 0, perms: 0 }])).toBe(false);
    expect(ownership.darwinAclEntriesAreSafe([{ tag: 3, perms: 0 }])).toBe(false);
    expect(ownership.darwinAclEntriesAreSafe(null)).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")("native deny-delete ACL accepts; a later allow-write ACL refuses", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-darwin-acl-")));
    const home = join(root, "codex");
    try {
      mkdirSync(home); chmodSync(root, 0o700); chmodSync(home, 0o700);
      writeFileSync(join(home, "config.toml"), 'model = "fixture"\n', { mode: 0o600 });
      const chmodAcl = (entry: string) => {
        const result = Bun.spawnSync(["/bin/chmod", "+a", entry, root], { stdout: "pipe", stderr: "pipe" });
        expect(result.success).toBe(true);
      };
      chmodAcl("everyone deny delete");
      expect(ownership.codexLaunchHomeIsOwned(home)).toBe(true);
      chmodAcl("everyone allow write");
      expect(ownership.codexLaunchHomeIsOwned(home)).toBe(false);
    } finally { removeTreeWithRetry(root); }
  });
});
