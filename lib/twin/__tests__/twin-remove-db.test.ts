// ShapesOS Phase 13 (twinui): removing a twin layout object (the layout
// editor's Delete → DELETE /api/ops/twin-objects?id=…) on real Postgres as
// the least-privilege app role: removed + audited inside the workspace, 404
// across workspaces (RLS + explicit scope), 405 for every entity that does
// not opt in with hooks.remove, 400 without an id; the bound record is
// untouched and the snapshot no longer lists the object.
//   DATABASE_URL=<app role url> npx tsx --test lib/twin/__tests__/twin-remove-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OpsError, opsCreate, opsEntityDef, opsRemove, type OpsActor } from "@/lib/ops/doctype";
import { OPS_ENTITIES } from "@/lib/ops/entities";
import { siteSnapshot } from "../state";

const WS = "p13twinui-ws-a";
const WS_B = "p13twinui-ws-b";
const A: OpsActor = { workspaceId: WS, userId: "user-p13twinui" };
const B: OpsActor = { workspaceId: WS_B, userId: "user-p13twinui-b" };

async function create(slug: string, body: Record<string, unknown>, actor: OpsActor = A) {
  const r = await withWorkspaceScope(actor.workspaceId, (tx) => opsCreate(tx, opsEntityDef(slug), actor, body));
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
}
const remove = (slug: string, id: unknown, actor: OpsActor = A) =>
  withWorkspaceScope(actor.workspaceId, (tx) => opsRemove(tx, opsEntityDef(slug), actor, id));
const status = (code: number) => (e: unknown) => e instanceof OpsError && e.status === code;

let siteId = "";
let rackLoc = "";

before(async () => {
  for (const id of [WS, WS_B]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now())`;
  }
  const wh = String((await create("warehouses", { name: "Main", code: "TU-MAIN" })).id);
  rackLoc = String((await create("locations", { warehouseId: wh, kind: "rack", code: "R-01" })).id);
  siteId = String((await create("twin-sites", { kind: "warehouse", name: "Main", code: "TU-01", gridW: 20, gridD: 12, warehouseId: wh })).id);
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe("p13 twin layout object removal (real Postgres, app role)", () => {
  it("removes the object, audits it, keeps the bound location, and the snapshot drops it", async () => {
    const obj = await create("twin-objects", { siteId, kind: "rack", label: "Rack 1", x: 2, z: 2, w: 6, d: 1, h: 4, bindingType: "location", bindingId: rackLoc });
    const id = String(obj.id);
    assert.ok((await siteSnapshot(WS, siteId)).objects.some((o) => o.id === id));

    // another workspace can't see it (404), and it is still there afterwards
    await assert.rejects(remove("twin-objects", id, B), status(404));

    const row = await remove("twin-objects", id);
    assert.equal(row.id, id);
    const left = await withWorkspaceScope(WS, (tx) => tx.opsSiteObject.count({ where: { id } }));
    assert.equal(left, 0);
    const loc = await withWorkspaceScope(WS, (tx) => tx.opsLocation.count({ where: { id: rackLoc } }));
    assert.equal(loc, 1, "the bound record is untouched");
    const audit = await withWorkspaceScope(WS, (tx) => tx.opsAuditEvent.findFirst({ where: { entity: "twin-objects", entityId: id, action: "remove" } }));
    assert.ok(audit, "audited in the same transaction");
    assert.match(audit!.summary, /Rack 1/);
    assert.equal((await siteSnapshot(WS, siteId)).objects.some((o) => o.id === id), false);

    // removing it again is a 404, not a silent success
    await assert.rejects(remove("twin-objects", id), status(404));
  });

  it("fails closed: entities without hooks.remove are 405; a missing id is 400", async () => {
    await assert.rejects(remove("twin-sites", siteId), status(405));
    await assert.rejects(remove("warehouses", "anything"), status(405));
    await assert.rejects(remove("twin-objects", ""), status(400));
    await assert.rejects(remove("twin-objects", undefined), status(400));
    const removable = OPS_ENTITIES.filter((d) => d.hooks?.remove).map((d) => d.slug);
    assert.deepEqual(removable, ["twin-objects"], "only layout objects can be removed");
  });
});
