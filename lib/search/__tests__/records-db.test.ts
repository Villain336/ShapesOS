// ShapesOS — global record search against real Postgres (Phase 4a).
// Every record type is found by name, results never cross workspaces (FORCE
// RLS + explicit scope), LIKE wildcards are literal, trashed files are
// hidden, and role gating/kind filters apply.
// Run (as the least-privilege app role): DATABASE_URL=… npx tsx --test lib/search/__tests__/records-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { likePattern, normalizeQuery, searchRecords, RECORD_KINDS } from "../records";

const WS = "p4a-search-ws";
const OTHER = "p4a-search-other";
const OWNER = "p4a-search-owner";

async function seed(ws: string, tag: string) {
  const pipeline = await prisma.pipeline.create({ data: { workspaceId: ws, name: "Sales", stages: [{ id: "new", label: "New" }] } });
  const lead = await prisma.lead.create({
    data: { workspaceId: ws, pipelineId: pipeline.id, name: `Zephyrine ${tag}`, email: `zeph-${tag}@example.test`, company: "Quillworks" },
  });
  await prisma.project.create({ data: { workspaceId: ws, domain: `zephyrine-${tag}.example` } });
  await prisma.workspaceFile.create({
    data: { workspaceId: ws, logicalPath: `/files/zephyrine-${tag}.pdf`, storageKey: `k-${ws}-1`, filename: `zephyrine-${tag}.pdf`, mimeType: "application/pdf", sizeBytes: 1, kind: "file", createdBy: OWNER },
  });
  await prisma.workspaceFile.create({
    data: { workspaceId: ws, logicalPath: `/files/zephyrine-trashed-${tag}.pdf`, storageKey: `k-${ws}-2`, filename: `zephyrine-trashed-${tag}.pdf`, mimeType: "application/pdf", sizeBytes: 1, kind: "file", createdBy: OWNER, trashedAt: new Date() },
  });
  await prisma.cadProject.create({ data: { workspaceId: ws, name: `Zephyrine rig ${tag}` } });
  await prisma.client.create({ data: { workspaceId: ws, name: `Zephyrine Client ${tag}`, loginEmail: `c-${tag}@example.test` } });
  await withWorkspaceScope(ws, async (tx) => {
    await tx.univerDoc.create({ data: { workspaceId: ws, kind: "doc", title: `Zephyrine plan ${tag}`, snapshot: {} } });
    await tx.opsInvoice.create({ data: { workspaceId: ws, customerId: lead.id, lineItems: [], totalCents: 12345 } });
    await tx.opsProject.create({ data: { workspaceId: ws, name: `Zephyrine rollout ${tag}` } });
    await tx.mission.create({
      data: {
        workspaceId: ws, template: "saas.signups", goal: { label: `Zephyrine growth ${tag}` }, planSnapshot: {}, checkpoints: [],
        budgetCaps: {}, termination: {}, createdBy: OWNER,
      },
    });
    await tx.socialPublication.create({
      data: { workspaceId: ws, createdBy: OWNER, content: `Zephyrine launch\n  day ${tag}`, status: "draft" },
    });
  });
}

before(async () => {
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  await prisma.workspace.create({ data: { id: OTHER, name: OTHER, ownerUserId: OWNER } });
  await seed(WS, "mine");
  await seed(OTHER, "theirs");
});

after(async () => {
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("record search (DB)", () => {
  it("finds every record type in the current workspace only", async () => {
    const hits = await searchRecords(WS, "viewer", "zephyrine", { perKind: 10 });
    const kinds = new Set(hits.map((h) => h.kind));
    for (const k of ["lead", "invoice", "doc", "file", "project", "ops_project", "mission", "cad_project", "client", "social_post"]) {
      assert.ok(kinds.has(k as never), `missing ${k}: ${[...kinds].join(",")}`);
    }
    assert.ok(hits.every((h) => !JSON.stringify(h).includes("theirs")), "no cross-workspace results");
    assert.ok(hits.every((h) => h.href.startsWith("/dashboard")));
    const lead = hits.find((h) => h.kind === "lead")!;
    assert.match(lead.href, /^\/dashboard\/crm\?lead=/);
    const invoice = hits.find((h) => h.kind === "invoice")!;
    assert.match(invoice.title, /Zephyrine mine/);
    assert.match(invoice.subtitle ?? "", /\$123\.45/);
    assert.match(hits.find((h) => h.kind === "doc")!.href, /^\/dashboard\/office\?open=/);
    assert.match(hits.find((h) => h.kind === "mission")!.title, /Zephyrine growth mine/);
    const social = hits.find((h) => h.kind === "social_post")!;
    assert.equal(social.title, "Zephyrine launch day mine", "whitespace collapsed");
    assert.match(social.href, /^\/dashboard\/social\?post=/);
  });

  it("matches email, company and partial words; hides trashed files", async () => {
    assert.ok((await searchRecords(WS, "viewer", "quillworks")).some((h) => h.kind === "lead"));
    assert.ok((await searchRecords(WS, "viewer", "zeph-mine@")).some((h) => h.kind === "lead"));
    const files = await searchRecords(WS, "viewer", "zephyrine", { kinds: ["file"] });
    assert.deepEqual(files.map((f) => f.title), ["zephyrine-mine.pdf"]);
  });

  it("treats LIKE wildcards literally and ignores tiny queries", async () => {
    assert.deepEqual(await searchRecords(WS, "viewer", "%%"), []);
    assert.deepEqual(await searchRecords(WS, "viewer", "z_ph"), []);
    assert.deepEqual(await searchRecords(WS, "viewer", "z"), []);
    assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%");
    assert.equal(normalizeQuery("  a  b  "), "a b");
    assert.equal(normalizeQuery("x"), null);
  });

  it("requires a role and honours kind filters", async () => {
    assert.deepEqual(await searchRecords(WS, null, "zephyrine"), []);
    const onlyLeads = await searchRecords(WS, "viewer", "zephyrine", { kinds: ["lead"] });
    assert.ok(onlyLeads.length > 0 && onlyLeads.every((h) => h.kind === "lead"));
    // Phase 18.2 (comms): +1 — the personal "mail" kind (Mail app threads).
    assert.equal(RECORD_KINDS.length, 24);
  });
});
