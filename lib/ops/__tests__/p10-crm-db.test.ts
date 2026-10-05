// ShapesOS Phase 10 (ops-core): CRM accounts on real Postgres — RLS on
// companies/contacts/deals, idempotent deduping Lead conversion, deal stage
// validation, OpsProject.dealId is a real FK.
// Run as the app role (scripts/test/db-tests.txt):
//   DATABASE_URL=<app role url> npx tsx --test lib/ops/__tests__/p10-crm-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, opsPatch, type OpsActor } from "../doctype";
import { convertLead } from "../crm";

const WS_A = "p10crm-ws-a";
const WS_B = "p10crm-ws-b";
const A: OpsActor = { workspaceId: WS_A, userId: "user-p10crm" };
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const inA = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(WS_A, fn);
const STAGES = [
  { id: "new", label: "New", color: "violet" },
  { id: "proposal", label: "Proposal", color: "amber" },
  { id: "won", label: "Won", color: "green" },
  { id: "lost", label: "Lost", color: "gray" },
];

let pipelineId = "";
const leadIds: Record<string, string> = {};

before(async () => {
  for (const id of [WS_A, WS_B]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now())`;
  }
  const p = await prisma.pipeline.create({ data: { workspaceId: WS_A, name: "Sales", stages: STAGES, isDefault: true } });
  pipelineId = p.id;
  const mk = (name: string, email: string | null, company: string | null, valueCents: number | null) =>
    prisma.lead.create({ data: { workspaceId: WS_A, pipelineId, name, email, company, stage: "proposal", valueCents } });
  leadIds.ann = (await mk("Ann", "Ann@Acme.com", "Acme Inc", 500000)).id;
  leadIds.bob = (await mk("Bob", "bob@acme.com", null, null)).id;
  leadIds.cy = (await mk("Cy", "cy@gmail.com", null, null)).id;
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe("p10 CRM accounts (real Postgres, app role)", () => {
  it("converts a lead into contact + company (+ deal), idempotently", async () => {
    const first = await inA((tx) => convertLead(tx, A, leadIds.ann!, { createDeal: true }));
    assert.deepEqual(first.created, { contact: true, company: true, deal: true });
    assert.equal(first.company?.domain, "acme.com");
    assert.equal(first.contact.email, "ann@acme.com");
    assert.equal(first.deal?.valueCents, 500000);
    assert.equal(first.deal?.stage, "proposal");
    const again = await inA((tx) => convertLead(tx, A, leadIds.ann!, { createDeal: true }));
    assert.deepEqual(again.created, { contact: false, company: false, deal: false });
    assert.equal(again.contact.id, first.contact.id);
    assert.equal(again.deal?.id, first.deal?.id);
  });

  it("dedupes the company by business email domain; free-mail gets none", async () => {
    const bob = await inA((tx) => convertLead(tx, A, leadIds.bob!));
    assert.equal(bob.created.company, false, "acme.com already exists");
    assert.equal(bob.contact.companyId, (await inA((tx) => tx.opsCompany.findFirst({ where: { domain: "acme.com" } })))!.id);
    const cy = await inA((tx) => convertLead(tx, A, leadIds.cy!));
    assert.equal(cy.company, null);
    assert.equal(await inA((tx) => tx.opsCompany.count({ where: { workspaceId: WS_A } })), 1);
  });

  it("manual contact/company creates dedupe (409)", async () => {
    await assert.rejects(
      inA((tx) => opsCreate(tx, def("contacts"), A, { name: "Ann again", email: "ANN@acme.com" })),
      (e: unknown) => e instanceof OpsError && e.status === 409,
    );
    await assert.rejects(
      inA((tx) => opsCreate(tx, def("companies"), A, { name: "Other", domain: "https://www.acme.com" })),
      (e: unknown) => e instanceof OpsError && e.status === 409,
    );
  });

  it("deal stages must exist in the pipeline; won/lost close the deal", async () => {
    const d = await inA((tx) => opsCreate(tx, def("deals"), A, { title: "Expansion", valueCents: 1000 }));
    assert.equal(d.outcome, "done");
    const row = (d as { row: Record<string, unknown> }).row;
    assert.equal(row.pipelineId, pipelineId, "defaults to the default pipeline");
    assert.equal(row.stage, "new");
    await assert.rejects(
      inA((tx) => opsPatch(tx, def("deals"), A, { id: row.id, stage: "nope" })),
      (e: unknown) => e instanceof OpsError && e.status === 422,
    );
    const won = await inA((tx) => opsPatch(tx, def("deals"), A, { id: row.id, stage: "won" }));
    const w = (won as { row: Record<string, unknown> }).row;
    assert.equal(w.status, "won");
    assert.ok(w.closedAt);
  });

  it("OpsProject.dealId is a real relation", async () => {
    const deal = await inA((tx) => tx.opsDeal.findFirst({ where: { workspaceId: WS_A } }));
    const ok = await inA((tx) => opsCreate(tx, def("projects"), A, { name: "Delivery", dealId: deal!.id }));
    assert.equal(ok.outcome, "done");
    await assert.rejects(inA((tx) => opsCreate(tx, def("projects"), A, { name: "Broken", dealId: "no-such-deal" })));
  });

  it("RLS: workspace B sees none of A's CRM accounts", async () => {
    const counts = await withWorkspaceScope(WS_B, async (tx) => [
      await tx.opsCompany.count({ where: { workspaceId: WS_A } }),
      await tx.opsContact.count({ where: { workspaceId: WS_A } }),
      await tx.opsDeal.count({ where: { workspaceId: WS_A } }),
    ]);
    assert.deepEqual(counts, [0, 0, 0]);
    const raw = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM ops_contacts`;
    assert.equal(Number(raw[0]!.n), 0, "no GUC → zero rows");
  });
});
