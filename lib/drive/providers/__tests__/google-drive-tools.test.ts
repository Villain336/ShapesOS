// ShapesOS — Phase 21B (WS=drive): the Google Drive connector's WRITE tools and how the
// platform tiers them. Against the Drive API MOCK (UNVERIFIED-LIVE).
// Run: npx tsx --test lib/drive/providers/__tests__/google-drive-tools.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoogleDriveAdapter } from "@/lib/connectors/m21/native/google-drive";
import { connectorAction } from "@/lib/agents/grants";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { decideAutoApproval } from "@/lib/automation/policy";
import { MockDriveApi } from "./mock-drive-api";

const publicResolve = async () => ["142.250.80.46"];
const cred = { kind: "oauth2" as const, payload: { access_token: "tok-1", refresh_token: "r-1" } };
const ctx = { workspaceId: "w", userId: "u" } as never;
function adapterWith(api: MockDriveApi) {
  return new GoogleDriveAdapter({ fetchImpl: api.fetchImpl, resolve: publicResolve, sleep: async () => {}, maxRetries: 0 });
}
const ON = { smallActionThresholdCents: 10000, automationAllows: false, defaultCurrency: "USD" } as never;

describe("Google Drive write tools", () => {
  it("create_folder, upload_text_file, rename_or_move_file and trash_file change Drive", async () => {
    const api = new MockDriveApi();
    const a = adapterWith(api);
    const folder = await a.invoke("create_folder", { name: "Reports" }, cred, ctx);
    assert.equal(folder.ok, true, folder.error);
    const fid = (folder.data as { id: string }).id;
    const up = await a.invoke("upload_text_file", { name: "q3.md", content: "# Q3\n", parentId: fid }, cred, ctx);
    assert.equal(up.ok, true, up.error);
    const file = (up.data as { id: string }).id;
    assert.equal(api.items.get(file)!.bytes!.toString(), "# Q3\n");
    const moved = await a.invoke("rename_or_move_file", { fileId: file, name: "q3-final.md", parentId: "root" }, cred, ctx);
    assert.equal(moved.ok, true, moved.error);
    assert.deepEqual([api.items.get(file)!.name, api.items.get(file)!.parents], ["q3-final.md", ["root"]]);
    const trashed = await a.invoke("trash_file", { fileId: file }, cred, ctx);
    assert.equal(trashed.ok, true);
    assert.equal(api.items.get(file)!.trashed, true, "trashed, not deleted: it is still recoverable");
  });

  it("delete_folder removes a folder for good and refuses a plain file", async () => {
    const api = new MockDriveApi();
    const a = adapterWith(api);
    const folder = api.create("Old", "application/vnd.google-apps.folder", ["root"], null);
    const file = api.create("keep.txt", "text/plain", ["root"], Buffer.from("k"));
    const refused = await a.invoke("delete_folder", { folderId: file.id }, cred, ctx);
    assert.equal(refused.ok, false);
    assert.ok(api.items.has(file.id));
    const done = await a.invoke("delete_folder", { folderId: folder.id }, cred, ctx);
    assert.equal(done.ok, true, done.error);
    assert.equal(api.items.has(folder.id), false);
  });

  it("with the read-only grant a write fails clearly instead of pretending", async () => {
    const api = new MockDriveApi();
    api.scope = "readonly";
    const r = await adapterWith(api).invoke("create_folder", { name: "X" }, cred, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "forbidden");
  });

  it("in mock mode (no credential) nothing is written and it says so", async () => {
    const api = new MockDriveApi();
    const r = await adapterWith(api).invoke("create_folder", { name: "X" }, null, ctx);
    assert.equal(r.mock, true);
    assert.equal(api.calls.length, 0);
  });

  it("rejects names with slashes and invalid ids before calling Drive", async () => {
    const api = new MockDriveApi();
    const a = adapterWith(api);
    assert.equal((await a.invoke("create_folder", { name: "a/b" }, cred, ctx)).ok, false);
    assert.equal((await a.invoke("trash_file", { fileId: "../etc" }, cred, ctx)).ok, false);
    assert.equal(api.calls.length, 0);
  });
});

describe("how the platform tiers the Drive tools", () => {
  const defs = new GoogleDriveAdapter().listTools();
  const desc = (n: string) => `${n}: ${defs.find((t) => t.name === n)!.description}`;
  it("folder delete is Tier 3 and can never be made automatic", () => {
    const action = connectorAction("google-drive", "delete_folder");
    assert.equal(action, "delete_drive_folder");
    assert.equal(evaluateTier({ kind: action, description: desc("delete_folder") }, ON), 3);
    const rule = { agentKey: "*", action, behavior: "auto" as const, thresholdCents: null };
    assert.equal(decideAutoApproval([rule], { agentKey: "lead", action, description: desc("delete_folder") }).auto, false);
  });
  it("the other writes are Tier 2: they ask, and a rule may allow them", () => {
    for (const t of ["create_folder", "upload_text_file", "rename_or_move_file", "trash_file"]) {
      const action = connectorAction("google-drive", t);
      assert.equal(action, "write_google_drive", t);
      assert.equal(evaluateTier({ kind: action, description: desc(t) }, ON), 2, t);
    }
  });
});
