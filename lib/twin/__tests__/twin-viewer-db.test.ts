// ShapesOS — Phase 14 (approvals), against Postgres as the app role:
//   1. Twin live for every viewer: a viewer gets the snapshot + patches of a
//      PUBLISHED site, is refused a draft (not found), and the stream ends
//      (access-revoked) when the site goes back to draft. The generic ops
//      route reads twin sites / objects / dock bookings at editor+.
//   2. The ops gate's automatable flag: an auto rule for publish_site_layout
//      approves the publish itself (audited, naming the rule) and the write
//      runs through the same verify + claim; a money slug never auto-approves,
//      even with a forced "auto" row.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/twin/__tests__/twin-viewer-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { opsCreate, opsEntityDef, opsPatch, type OpsActor } from "@/lib/ops/doctype";
import { requireWorkspaceRole } from "@/lib/authz";
import { siteSnapshotFor, twinLiveAccess, TwinNotFoundError } from "../state";
import { twinLiveStream } from "../live";

const RUN = `p14tv-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const EDITOR = `${RUN}-editor`;
const VIEWER = `${RUN}-viewer`;
const A: OpsActor = { workspaceId: WS, userId: EDITOR };
const inA = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(WS, fn);

async function create(slug: string, body: Record<string, unknown>) {
  const r = await inA((tx) => opsCreate(tx, opsEntityDef(slug), A, body));
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
}
const setRule = (action: string, behavior: "auto" | "ask" | "never", agentKey = "*") =>
  inA((tx) =>
    tx.automationSetting.upsert({
      where: { workspaceId_agentKey_action: { workspaceId: WS, agentKey, action } },
      create: { workspaceId: WS, agentKey, action, behavior, updatedBy: EDITOR },
      update: { behavior },
    }),
  );

let siteId = "";
let dock = "";

before(async () => {
  await prisma.workspace.create({ data: { id: WS, name: RUN, ownerUserId: `${RUN}-owner` } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: EDITOR, role: "editor", email: `${EDITOR}@example.com` } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: VIEWER, role: "viewer", email: `${VIEWER}@example.com` } });
  const wh = String((await create("warehouses", { name: "Main", code: `${RUN}-WH`.slice(0, 30) })).id);
  dock = String((await create("locations", { warehouseId: wh, kind: "dock", code: "D1" })).id);
  siteId = String((await create("twin-sites", { kind: "warehouse", name: "Main", code: "TV-01", gridW: 20, gridD: 20, warehouseId: wh })).id);
  await create("twin-objects", { siteId, kind: "dock_door", label: "Dock 1", x: 0, z: 18, w: 3, d: 2, bindingType: "location", bindingId: dock });
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM notifications WHERE workspace_id = ${WS}`;
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

type Frame = { event: string; data: unknown };
function frames(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    reader,
    async next(): Promise<Frame> {
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (raw.startsWith(":")) continue;
          return { event: /^event: (.*)$/m.exec(raw)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(raw)![1]!) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += decoder.decode(value, { stream: true });
      }
    },
  };
}

const viewerAccess = () =>
  twinLiveAccess({
    workspaceId: WS,
    siteId,
    isMember: async () => Boolean(await requireWorkspaceRole(VIEWER, WS, "viewer")),
    isEditor: async () => Boolean(await requireWorkspaceRole(VIEWER, WS, "editor")),
  });

describe("Phase 14: the ops gate's automatable flag (publish a twin layout)", () => {
  it("without a rule the publish waits for a person", async () => {
    const r = await inA((tx) => opsPatch(tx, opsEntityDef("twin-sites"), A, { id: siteId, status: "published" }));
    assert.equal(r.outcome, "approval_required");
    if (r.outcome !== "approval_required") return;
    assert.equal(r.approval.status, "pending");
    assert.equal((await inA((tx) => tx.opsSite.findFirstOrThrow({ where: { id: siteId } }))).status, "draft");
  });

  it("a viewer is refused the DRAFT: snapshot not found, stream never starts", async () => {
    await assert.rejects(siteSnapshotFor(WS, siteId, false), TwinNotFoundError);
    const editorSees = await siteSnapshotFor(WS, siteId, true);
    assert.equal(editorSees.site.status, "draft");
    await assert.rejects(viewerAccess().snapshot(), TwinNotFoundError);
    assert.equal(await viewerAccess().stillAllowed(), false);
  });

  it("with an auto rule for publish_site_layout the publish is approved by the rule and runs, audited", async () => {
    await setRule("publish_site_layout", "auto");
    const r = await inA((tx) => opsPatch(tx, opsEntityDef("twin-sites"), A, { id: siteId, status: "published" }));
    assert.equal(r.outcome, "done");
    if (r.outcome !== "done") return;
    assert.equal(r.action, "gate_executed");
    assert.match(r.autoApproved ?? "", /auto-approved by the publish_site_layout rule for every agent/);
    assert.equal((await inA((tx) => tx.opsSite.findFirstOrThrow({ where: { id: siteId } }))).status, "published");
    // The approval row: approved by the automation (no person), then claimed once.
    const approval = await inA((tx) =>
      tx.composioActionApproval.findFirstOrThrow({ where: { workspaceId: WS, toolName: "OPS_TWIN_SITE_PUBLISH" }, orderBy: { createdAt: "desc" } }),
    );
    assert.equal(approval.status, "executed");
    assert.equal(approval.decidedBy, "automation");
    assert.match(approval.decisionReason ?? "", /publish_site_layout rule/);
    const trail = approval.auditTrail as Array<{ event: string; actor: string }>;
    assert.deepEqual(trail.map((e) => e.event), ["proposed", "approved", "execution_claimed"]);
    assert.equal(trail[1]!.actor, "automation");
    const audit = await inA((tx) => tx.opsAuditEvent.findMany({ where: { workspaceId: WS, entityId: siteId }, orderBy: { createdAt: "asc" } }));
    assert.ok(audit.some((e) => e.action === "gate_auto_approved" && /publish_site_layout rule/.test(e.summary)));
    assert.ok(audit.some((e) => e.action === "gate_executed"));
    // Nobody was asked: no "approval needed" notification for it.
    const notes = await prisma.notification.count({ where: { workspaceId: WS, sourceId: approval.id } });
    assert.equal(notes, 0);
  });

  it("a money slug never auto-approves, even with forced auto rows", async () => {
    // Forced rows bypassing the PUT guard (Tier 3 kinds would be refused there).
    for (const action of ["send_invoice", "publish_site_layout", "mark_invoice_paid"]) await setRule(action, "auto");
    const inv = await create("invoices", { lineItems: [{ description: "Retainer", qty: 1, priceCents: 50_000 }] });
    const r = await inA((tx) => opsPatch(tx, opsEntityDef("invoices"), A, { id: String(inv.id), status: "sent" }));
    assert.equal(r.outcome, "approval_required");
    if (r.outcome !== "approval_required") return;
    assert.equal(r.approval.status, "pending");
    assert.equal(r.approval.autoApproved, undefined);
    assert.equal((await inA((tx) => tx.opsInvoice.findFirstOrThrow({ where: { id: String(inv.id) } }))).status, "draft");
  });
});

describe("Phase 14: twin live for every viewer", () => {
  it("the generic ops route reads twin sites / objects / bookings at editor+ (no draft leak)", () => {
    for (const slug of ["twin-sites", "twin-objects", "dock-bookings"]) assert.equal(opsEntityDef(slug).readRole, "editor", slug);
  });

  it("a viewer gets the snapshot, then a patch after a write, and the stream ends when the site goes back to draft", async () => {
    assert.equal((await inA((tx) => tx.opsSite.findFirstOrThrow({ where: { id: siteId } }))).status, "published");
    assert.ok(await requireWorkspaceRole(VIEWER, WS, "viewer"));
    assert.equal(await requireWorkspaceRole(VIEWER, WS, "editor"), null, "the viewer is not an editor");
    const access = viewerAccess();
    const first = await access.snapshot();
    const stream = frames(twinLiveStream(first, { ...access, pollMs: 60, maxMs: 8000, heartbeatMs: 10_000 }));
    const f0 = await stream.next();
    assert.equal(f0.event, "snapshot");
    // An editor books the dock: the viewer receives a patch.
    await create("dock-bookings", { siteId, dockLocationId: dock, direction: "inbound", truckRef: "TRK-VIEW", eta: new Date(Date.now() + 3600_000).toISOString() });
    const f1 = await stream.next();
    assert.equal(f1.event, "patch");
    assert.ok(JSON.stringify(f1.data).includes("TRK-VIEW"));
    // Un-publishing is free; the viewer's stream ends on the next tick.
    await inA((tx) => opsPatch(tx, opsEntityDef("twin-sites"), A, { id: siteId, status: "draft" }));
    let end: Frame | null = null;
    for (let i = 0; i < 10 && !end; i++) {
      const f = await stream.next();
      if (f.event === "end") end = f;
    }
    assert.deepEqual(end?.data, { reason: "access-revoked" });
    await stream.reader.cancel().catch(() => undefined);
  });

  it("an editor's stream of the draft keeps going (drafts stay editor+)", async () => {
    const editor = twinLiveAccess({
      workspaceId: WS,
      siteId,
      isMember: async () => Boolean(await requireWorkspaceRole(EDITOR, WS, "viewer")),
      isEditor: async () => Boolean(await requireWorkspaceRole(EDITOR, WS, "editor")),
    });
    assert.equal(await editor.stillAllowed(), true);
    assert.equal((await editor.snapshot()).site.status, "draft");
  });

  it("a member who leaves loses the stream", async () => {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: WS, userId: VIEWER } });
    assert.equal(await viewerAccess().stillAllowed(), false);
  });
});
