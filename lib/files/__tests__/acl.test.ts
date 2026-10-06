// ShapesOS — Phase 18.2 (WS=content): per-file access arithmetic (unit).
// Run: npx tsx --test lib/files/__tests__/acl.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FILE_ROLES, checkOverride, defaultFileRole, effectiveFileRole, fileCan, fileRoleCap, type FileRole, type WorkspaceRoleName } from "../acl";

const WS_ROLES: WorkspaceRoleName[] = ["viewer", "editor", "admin", "owner"];
const RANK: Record<FileRole, number> = { viewer: 1, editor: 2, owner: 3 };

describe("per-file access", () => {
  it("is NEVER wider than the workspace allows, for every role × override × creator", () => {
    for (const ws of WS_ROLES) {
      for (const isCreator of [false, true]) {
        for (const override of [null, ...FILE_ROLES]) {
          const eff = effectiveFileRole({ workspaceRole: ws, isCreator, override });
          assert.ok(RANK[eff] <= RANK[fileRoleCap(ws)], `${ws}/${override}/${isCreator} → ${eff}`);
          if (ws === "viewer") assert.equal(eff, "viewer", "a workspace viewer can never edit a file");
          if (ws === "admin" || ws === "owner") assert.equal(eff, "owner", "admins are never narrowed");
        }
      }
    }
  });

  it("defaults: editors edit, the editor who made it owns it, viewers view", () => {
    assert.equal(defaultFileRole("editor", false), "editor");
    assert.equal(defaultFileRole("editor", true), "owner");
    assert.equal(defaultFileRole("viewer", true), "viewer");
    assert.equal(effectiveFileRole({ workspaceRole: "editor", isCreator: false, override: "viewer" }), "viewer", "an override narrows an editor");
    assert.equal(effectiveFileRole({ workspaceRole: "editor", isCreator: true, override: "viewer" }), "viewer", "…even the one who made it");
    assert.equal(effectiveFileRole({ workspaceRole: "editor", isCreator: false, override: "owner" }), "owner", "an editor can be made a file owner");
    assert.equal(effectiveFileRole({ workspaceRole: "viewer", isCreator: false, override: "editor" }), "viewer", "a stored too-wide override is clamped");
  });

  it("what each file role may do", () => {
    assert.ok(fileCan("viewer", "view") && fileCan("viewer", "download"));
    assert.ok(!fileCan("viewer", "edit") && !fileCan("viewer", "share") && !fileCan("viewer", "annotate") && !fileCan("viewer", "trash"));
    assert.ok(fileCan("editor", "version") && fileCan("editor", "share") && !fileCan("editor", "manageAccess"));
    assert.ok(fileCan("owner", "manageAccess"));
  });

  it("refuses overrides wider than the cap, and any override on an admin", () => {
    assert.deepEqual(checkOverride("editor", "owner"), { ok: true });
    assert.deepEqual(checkOverride("viewer", "viewer"), { ok: true });
    assert.equal(checkOverride("viewer", "editor").ok, false);
    assert.equal(checkOverride("viewer", "owner").ok, false);
    assert.equal(checkOverride("admin", "viewer").ok, false);
    assert.equal(checkOverride("owner", "owner").ok, false);
  });
});
