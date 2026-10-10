// ShapesOS — Phase 21B (WS=drive): folder ACL inheritance and private homes (unit).
// Run: npx tsx --test lib/drive/__tests__/acl.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ancestorsOf, resolveDriveRole, visibleToAll, type AclEntry } from "../acl";

const E = (path: string, userId: string, role: "viewer" | "editor" | "owner"): AclEntry => ({ path, userId, role });

describe("ancestorsOf", () => {
  it("lists the path itself and every folder above it, deepest first", () => {
    assert.deepEqual(ancestorsOf("/shared/a/b/c.txt"), ["/shared/a/b/c.txt", "/shared/a/b", "/shared/a", "/shared"]);
    assert.deepEqual(ancestorsOf("/files/x.txt"), ["/files/x.txt", "/files"]);
  });
});

describe("workspace areas (/shared and the system folders)", () => {
  const base = { workspaceRole: "editor" as const, userId: "u1", ownerUserId: null, createdBy: "u9", path: "/shared/Marketing/plan.docx", entries: [] as AclEntry[] };

  it("defaults to the workspace role when nothing is set", () => {
    assert.equal(resolveDriveRole(base), "editor");
    assert.equal(resolveDriveRole({ ...base, workspaceRole: "viewer" }), "viewer");
    assert.equal(resolveDriveRole({ ...base, workspaceRole: "admin" }), "owner");
  });

  it("a folder entry is inherited by everything beneath it", () => {
    const entries = [E("/shared/Marketing", "u1", "viewer")];
    assert.equal(resolveDriveRole({ ...base, entries }), "viewer");
    assert.equal(resolveDriveRole({ ...base, path: "/shared/Marketing/deep/er/x.txt", entries }), "viewer");
    assert.equal(resolveDriveRole({ ...base, path: "/shared/Sales/x.txt", entries }), "editor", "a sibling folder is untouched");
  });

  it("a deeper entry overrides a shallower one (child wins), in both directions", () => {
    const narrow = [E("/shared/Marketing", "u1", "owner"), E("/shared/Marketing/plan", "u1", "viewer")];
    assert.equal(resolveDriveRole({ ...base, path: "/shared/Marketing/plan/x.txt", entries: narrow }), "viewer");
    assert.equal(resolveDriveRole({ ...base, path: "/shared/Marketing/other.txt", entries: narrow }), "owner");
    const wide = [E("/shared/Marketing", "u1", "viewer"), E("/shared/Marketing/plan/x.txt", "u1", "editor")];
    assert.equal(resolveDriveRole({ ...base, path: "/shared/Marketing/plan/x.txt", entries: wide }), "editor", "a file entry wins over its folder");
  });

  it("ignores other people's entries", () => {
    assert.equal(resolveDriveRole({ ...base, entries: [E("/shared/Marketing", "u2", "viewer")] }), "editor");
  });

  it("is never wider than the workspace role, and admins are never narrowed", () => {
    assert.equal(resolveDriveRole({ ...base, workspaceRole: "viewer", entries: [E("/shared/Marketing", "u1", "owner")] }), "viewer");
    assert.equal(resolveDriveRole({ ...base, workspaceRole: "admin", entries: [E("/shared/Marketing", "u1", "viewer")] }), "owner");
  });

  it("the editor who made the file owns it unless an entry narrows it", () => {
    assert.equal(resolveDriveRole({ ...base, createdBy: "u1" }), "owner");
    assert.equal(resolveDriveRole({ ...base, createdBy: "u1", entries: [E("/shared/Marketing", "u1", "viewer")] }), "viewer");
  });
});

describe("private homes", () => {
  const home = { userId: "u2", ownerUserId: "u1", createdBy: "u1", path: "/home/u1/Taxes/return.pdf", entries: [] as AclEntry[] };

  it("belongs entirely to its owner", () => {
    assert.equal(resolveDriveRole({ ...home, userId: "u1", workspaceRole: "editor" }), "owner");
    assert.equal(resolveDriveRole({ ...home, userId: "u1", workspaceRole: "viewer" }), "viewer", "a workspace viewer still can't edit");
  });

  it("is invisible to other members, admins and owners included", () => {
    for (const workspaceRole of ["viewer", "editor", "admin", "owner"] as const) {
      assert.equal(resolveDriveRole({ ...home, workspaceRole }), null, workspaceRole);
    }
  });

  it("opens only through an explicit share, on that folder or file, and never above editor", () => {
    const shared = [E("/home/u1/Taxes", "u2", "viewer")];
    assert.equal(resolveDriveRole({ ...home, workspaceRole: "admin", entries: shared }), "viewer", "an admin gets only what was shared");
    assert.equal(resolveDriveRole({ ...home, workspaceRole: "editor", path: "/home/u1/Other/x.txt", entries: shared }), null);
    assert.equal(resolveDriveRole({ ...home, workspaceRole: "editor", entries: [E("/home/u1/Taxes", "u2", "owner")] }), "editor", "a share can't hand over ownership of someone's home");
    assert.equal(resolveDriveRole({ ...home, workspaceRole: "viewer", entries: [E("/home/u1/Taxes", "u2", "editor")] }), "viewer", "clamped to the workspace role");
  });

  it("an explicit share can be narrowed again deeper down", () => {
    const entries = [E("/home/u1/Taxes", "u2", "editor"), E("/home/u1/Taxes/return.pdf", "u2", "viewer")];
    assert.equal(resolveDriveRole({ ...home, workspaceRole: "editor", entries }), "viewer");
  });
});

describe("visibleToAll", () => {
  it("is false for the private roots, true for the rest", () => {
    assert.equal(visibleToAll("/home/u1/a.txt"), false);
    assert.equal(visibleToAll("/shared/a.txt"), true);
    assert.equal(visibleToAll("/files/a.txt"), true);
    assert.equal(visibleToAll("/agents/r1/a.txt"), true);
    assert.equal(visibleToAll("/apps/a/i/a.txt"), true);
  });
});
