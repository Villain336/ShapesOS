// ShapesOS — Phase 18.1 (WS=find): Spotlight against real Postgres.
//   - full text finds words INSIDE an uploaded PDF (uploaded through the real
//     filesystem service, extracted by the existing PDF extractor, chunked,
//     indexed), an Office doc's body, ticket messages, inbox messages, chat
//     messages, contacts / companies / deals / people / apps
//   - meaning finds a paraphrase through pgvector (embeddings from a
//     DETERMINISTIC TEST EMBEDDER — MOCK; the real MiniLM path is verified by
//     scripts/verify-phase18-spotlight.mts)
//   - permissions per source: another workspace never; a viewer never sees a
//     draft app; a teammate's chat is never found; a role below a source's
//     gate gets nothing; trashed files vanish
//   - ranking: an exact name beats a text-only hit; websearch syntax (phrase,
//     exclusion, kind: filter) works
//   - the index is idempotent (backfill twice = no change) and a changed
//     doc re-indexes; the agents' search_workspace tool returns the same hits
//     and reads a file's text by record id
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test --experimental-test-module-mocks lib/search/__tests__/spotlight-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

process.env.SPOTLIGHT_INDEX_ON_WRITE = "off"; // the test indexes explicitly (no background race)

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { writeFile, trashFile } from "@/lib/filesystem/service";
import { spotlight, searchRecords } from "../records";
import { backfillTextIndex, indexFileText, indexUniverDocText } from "../text-index";
import { setSpotlightEmbedder } from "../semantic";
import { search_workspace } from "../tool";
import { buildDocSnapshot } from "@/lib/univer/snapshots";

const RUN = randomUUID().slice(0, 8);
const WS = `p18sl-${RUN}`;
const OTHER = `p18sl-o-${RUN}`;
const ANA = `p18sl-ana-${RUN}`;
const BEN = `p18sl-ben-${RUN}`;

// ---- MOCK embedder (deterministic, test-only) ------------------------------
// Bag of concepts → 384-d unit vector. Synonyms share a concept so a
// paraphrase lands near its source text; unrelated words land elsewhere.
const CONCEPTS: Record<string, number> = { forecast: 1, outlook: 1, projection: 1, revenue: 2, income: 2, earnings: 2, quarter: 3, quarterly: 3 };
function hashWord(w: string): number {
  let h = 2166136261;
  for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return 10 + (Math.abs(h) % 370);
}
async function mockEmbed(text: string): Promise<number[]> {
  const v = new Array(384).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) v[CONCEPTS[w] ?? hashWord(w)] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function makePdf(lines: string[]): Buffer {
  const ops = lines.map((l) => `BT (${l}) Tj ET`).join("\n") + "\n";
  const deflated = deflateSync(Buffer.from(ops, "latin1"));
  const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, "latin1");
  const tail = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
  return Buffer.concat([head, deflated, tail]);
}

let pdfId = "";
let docId = "";
let draftAppSlug = "";

async function seed(ws: string, tag: string) {
  const pipeline = await prisma.pipeline.create({ data: { workspaceId: ws, name: "Sales", stages: [{ id: "new", label: "New" }] } });
  const lead = await prisma.lead.create({ data: { workspaceId: ws, pipelineId: pipeline.id, name: `Orrin Vale ${tag}`, email: `orrin-${tag}@example.test`, phone: "+15550000" } });
  const project = await prisma.project.create({ data: { workspaceId: ws, domain: `kestrel-${tag}.example` } });
  await prisma.outboundMessage.create({
    data: { workspaceId: ws, leadId: lead.id, channel: "email", direction: "inbound", kind: "reply", subject: "Re: pallets", body: `Can you ship the marigold pallets on Friday? ${tag}`, status: "delivered" },
  });
  const anaThread = await prisma.aiChatThread.create({ data: { projectId: project.id, userId: ANA, title: `Plan ${tag}` } });
  await prisma.aiChatMessage.create({ data: { threadId: anaThread.id, role: "user", content: `Remind me about the zinnia supplier contract ${tag}` } });
  const benThread = await prisma.aiChatThread.create({ data: { projectId: project.id, userId: BEN, title: `Ben ${tag}` } });
  await prisma.aiChatMessage.create({ data: { threadId: benThread.id, role: "user", content: `Private note about zinnia bonuses ${tag}` } });
  await prisma.connectorPerson.create({ data: { workspaceId: ws, name: `Talia Quorn ${tag}`, roles: ["investor"], handles: ["@taliaq"], consentedBy: ANA } });
  await withWorkspaceScope(ws, async (tx) => {
    const company = await tx.opsCompany.create({ data: { workspaceId: ws, name: `Brindle Works ${tag}`, domain: `brindle-${tag}.example`, notes: "Prefers invoices quarterly" } });
    const contact = await tx.opsContact.create({ data: { workspaceId: ws, name: `Pell Ardent ${tag}`, email: `pell-${tag}@example.test`, companyId: company.id, notes: "Met at the heliotrope expo" } });
    const opsPipeline = await tx.pipeline.findFirstOrThrow({ where: { id: pipeline.id } });
    await tx.opsDeal.create({ data: { workspaceId: ws, title: `Brindle renewal ${tag}`, pipelineId: opsPipeline.id, stage: "new", valueCents: 250000, contactId: contact.id, companyId: company.id } });
    const ticket = await tx.opsTicket.create({ data: { workspaceId: ws, number: 7, subject: `Printer jam ${tag}`, requesterEmail: `req-${tag}@example.test` } });
    await tx.opsTicketMessage.create({ data: { workspaceId: ws, ticketId: ticket.id, direction: "inbound", body: `The obsidian tray keeps jamming every morning ${tag}` } });
    await tx.miniApp.create({ data: { workspaceId: ws, slug: `vendors-${tag}`, name: `Quillon vendors ${tag}`, draftSpec: {}, published: true, version: 1, createdBy: ANA } });
    const draft = await tx.miniApp.create({ data: { workspaceId: ws, slug: `drafty-${tag}`, name: `Quillon drafts ${tag}`, draftSpec: {}, published: false, createdBy: ANA } });
    if (ws === WS) draftAppSlug = draft.slug;
    const d = await tx.univerDoc.create({
      data: { workspaceId: ws, kind: "doc", title: `Board memo ${tag}`, snapshot: buildDocSnapshot({ title: "Board memo", paragraphs: [`We expect strong revenue next quarter. Codeword saffronite ${tag}.`] }) as object },
    });
    if (ws === WS) docId = d.id;
  });
  const file = await writeFile({
    workspaceId: ws,
    logicalPath: `/files/report-${tag}.pdf`,
    kind: "file",
    bytes: makePdf([`Quarterly revenue forecast for the Ostrava plant ${tag}`, "Cash position is healthy.", "Codeword tamarillo."]),
    mimeType: "application/pdf",
    createdBy: ANA,
  });
  if (ws === WS) pdfId = file.id;
}

before(async () => {
  setSpotlightEmbedder(mockEmbed);
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ANA } });
  await prisma.workspace.create({ data: { id: OTHER, name: OTHER, ownerUserId: BEN } });
  await seed(WS, "mine");
  await seed(OTHER, "theirs");
  for (const ws of [WS, OTHER]) await backfillTextIndex({ workspaceId: ws, embedder: mockEmbed });
});

after(async () => {
  setSpotlightEmbedder(null);
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

const find = (q: string, opts: Parameters<typeof spotlight>[3] = {}) => spotlight(WS, "viewer", q, { userId: ANA, ...opts });

describe("Spotlight (DB)", () => {
  it("finds text inside an uploaded PDF, with a snippet, in this workspace only", async () => {
    const { hits } = await find("tamarillo");
    const pdf = hits.find((h) => h.kind === "file_content");
    assert.ok(pdf, `file_content hit: ${JSON.stringify(hits.map((h) => h.kind))}`);
    assert.equal(pdf.id, pdfId);
    assert.equal(pdf.title, "report-mine.pdf");
    assert.ok(pdf.match.includes("text"));
    assert.match(pdf.snippet ?? "", /⟦tamarillo⟧/i);
    assert.deepEqual(pdf.ref, { fileId: pdfId });
    assert.ok(hits.every((h) => !JSON.stringify(h).includes("theirs")), "never another workspace");
    // English stemming: "forecasts" finds "forecast".
    assert.ok((await find("ostrava forecasts")).hits.some((h) => h.id === pdfId));
  });

  it("finds an Office doc by the words in its body", async () => {
    const { hits } = await find("saffronite");
    assert.ok(hits.some((h) => h.kind === "file_content" && h.id === docId && h.href.startsWith("/dashboard/office?open=")));
  });

  it("finds by meaning: a paraphrase with none of the words (pgvector; MOCK embedder)", async () => {
    const res = await find("income projection", { semantic: "wait" });
    assert.equal(res.semantic, "used");
    const hit = res.hits.find((h) => h.id === pdfId);
    assert.ok(hit, `meaning hit: ${JSON.stringify(res.hits.map((h) => [h.kind, h.title, h.match]))}`);
    assert.deepEqual(hit.match, ["meaning"]);
    const off = await find("income projection", { semantic: "off" });
    assert.ok(!off.hits.some((h) => h.id === pdfId), "without meaning-search there is no literal match");
  });

  it("covers the new sources: tickets (by message), inbox, contacts, companies, deals, people, apps", async () => {
    const kindsFor = async (q: string) => new Set((await find(q)).hits.map((h) => h.kind));
    assert.ok((await kindsFor("obsidian")).has("ticket"), "a word inside a ticket message");
    assert.ok((await kindsFor("marigold")).has("inbox_message"));
    assert.ok((await kindsFor("heliotrope")).has("contact"), "a word in the contact's notes");
    assert.ok((await kindsFor("Brindle")).has("company"));
    assert.ok((await kindsFor("Brindle renewal")).has("deal"));
    assert.ok((await kindsFor("Talia Quorn")).has("person"));
    assert.ok((await kindsFor("Quillon")).has("app"));
    const ticket = (await find("obsidian")).hits.find((h) => h.kind === "ticket")!;
    assert.match(ticket.snippet ?? "", /⟦obsidian⟧/);
    assert.match(ticket.href, /^\/dashboard\/ops\/helpdesk\?ticket=/);
    assert.ok(ticket.actions?.some((a) => a.tool === "ops_reply_ticket"), "act on it: reply through the tool registry");
  });

  it("chats are personal: Ana finds hers, never Ben's; no user = no chats", async () => {
    const mine = await spotlight(WS, "owner", "zinnia", { userId: ANA });
    const chats = mine.hits.filter((h) => h.kind === "chat_message");
    assert.equal(chats.length, 1);
    assert.match(chats[0]!.snippet ?? "", /supplier/);
    const bens = await spotlight(WS, "owner", "zinnia", { userId: BEN });
    assert.ok(bens.hits.filter((h) => h.kind === "chat_message").every((h) => /bonuses/.test(h.snippet ?? "")), "Ben only sees his own");
    assert.equal((await spotlight(WS, "owner", "zinnia", {})).hits.filter((h) => h.kind === "chat_message").length, 0);
  });

  it("drafts: a viewer never sees an unpublished app; an editor does", async () => {
    const viewer = await spotlight(WS, "viewer", "Quillon", { kinds: ["app"] });
    assert.deepEqual(viewer.hits.map((h) => h.title), ["Quillon vendors mine"]);
    const editor = await spotlight(WS, "editor", "Quillon", { kinds: ["app"] });
    assert.ok(editor.hits.some((h) => h.href === `/dashboard/apps/${draftAppSlug}` && /Draft/.test(h.subtitle ?? "")));
  });

  it("every source stays in its workspace (each kind is seeded in both)", async () => {
    // Every OTHER record carries the word "theirs"; nothing in WS does.
    const theirsThere = await spotlight(OTHER, "owner", "theirs", { userId: ANA, perKind: 20 });
    const kindsThere = new Set(theirsThere.hits.map((h) => h.kind));
    for (const k of ["lead", "file_content", "inbox_message", "chat_message", "contact", "company", "deal", "person", "ticket", "app", "project"]) {
      assert.ok(kindsThere.has(k as never), `seeded ${k} in the other workspace: ${[...kindsThere].join(",")}`);
    }
    const here = await spotlight(WS, "owner", "theirs", { userId: ANA, perKind: 20, semantic: "off" });
    assert.deepEqual(here.hits.map((h) => `${h.kind}:${h.title}`), [], "no source leaks across workspaces");
  });

  it("no role, another workspace, trashed files: nothing", async () => {
    assert.deepEqual(await searchRecords(WS, null, "tamarillo"), []);
    const theirs = await spotlight(OTHER, "viewer", "tamarillo", { userId: BEN });
    assert.ok(theirs.hits.every((h) => h.id !== pdfId));
    await trashFile({ workspaceId: WS, fileId: pdfId });
    assert.ok(!(await find("tamarillo")).hits.some((h) => h.id === pdfId), "a trashed file vanishes");
    await prisma.workspaceFile.update({ where: { id: pdfId }, data: { trashedAt: null } });
  });

  it("ranking and query syntax", async () => {
    const { hits } = await find("Orrin Vale mine");
    assert.equal(hits[0]?.kind, "lead", "an exact name leads");
    assert.equal(hits[0]?.match[0], "name");
    // kind: filter narrows; exclusion and phrase reach the full text.
    assert.ok((await find("tamarillo in:tickets")).hits.every((h) => h.kind === "ticket"));
    assert.ok((await find("\"revenue forecast\"")).hits.some((h) => h.id === pdfId));
    assert.ok(!(await find("tamarillo -healthy")).hits.some((h) => h.id === pdfId), "excluded word");
    // Deterministic: same query, same order.
    const a = (await find("mine")).hits.map((h) => `${h.kind}:${h.id}`);
    const b = (await find("mine")).hits.map((h) => `${h.kind}:${h.id}`);
    assert.deepEqual(a, b);
  });

  it("the index is idempotent and follows changes", async () => {
    const again = await backfillTextIndex({ workspaceId: WS, embedder: mockEmbed });
    assert.equal(again.files.indexed + again.docs.indexed, 0, `nothing re-extracted: ${JSON.stringify(again)}`);
    assert.ok(again.files.unchanged >= 1 && again.docs.unchanged >= 1);
    const chunksBefore = await withWorkspaceScope(WS, (tx) => tx.searchTextChunk.count({ where: { workspaceId: WS } }));
    assert.equal((await indexFileText(WS, pdfId, { embedder: mockEmbed })).status, "unchanged");
    assert.equal(await withWorkspaceScope(WS, (tx) => tx.searchTextChunk.count({ where: { workspaceId: WS } })), chunksBefore);
    // Edit the doc: its text re-indexes and the old word is gone.
    await withWorkspaceScope(WS, (tx) =>
      tx.univerDoc.update({ where: { id: docId }, data: { snapshot: buildDocSnapshot({ title: "Board memo", paragraphs: ["Codeword vermilionite now."] }) as object } }),
    );
    assert.equal((await indexUniverDocText(WS, docId, { embedder: mockEmbed })).status, "indexed");
    assert.ok(!(await find("saffronite")).hits.some((h) => h.id === docId));
    assert.ok((await find("vermilionite")).hits.some((h) => h.id === docId));
    // RLS: the chunks are invisible without the workspace GUC.
    const unscoped = (await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM search_text_chunks`)[0]!.n;
    assert.equal(unscoped, 0, "FORCE RLS: no GUC, no rows");
  });

  it("agents search the same index (search_workspace) and read a file by record id", async () => {
    const ctx = { projectId: "p", workspaceId: WS, userId: ANA, role: "viewer" as const, confirmed: false };
    const res = await search_workspace.execute(ctx, { query: "tamarillo" });
    const people = (await find("tamarillo")).hits.map((h) => `${h.kind}:${h.id}`);
    const agents = ((res.details as { results: Array<{ kind: string; id: string }> }).results ?? []).map((h) => `${h.kind}:${h.id}`);
    assert.deepEqual(agents, people, "same hits, same order");
    const read = await search_workspace.execute(ctx, { record: `file_content:${pdfId}` });
    assert.match(read.summary, /Ostrava plant/);
    const bad = await search_workspace.execute(ctx, { record: "file_content:../../etc" });
    assert.match(bad.summary, /record must look like/);
    assert.equal(search_workspace.kind, "safe");
  });

  it("the upload write hook indexes a new file in the background (lazy-loaded indexer)", async () => {
    process.env.SPOTLIGHT_INDEX_ON_WRITE = "on";
    try {
      const file = await writeFile({
        workspaceId: WS,
        logicalPath: `/files/hook-${RUN}.txt`,
        kind: "file",
        bytes: Buffer.from("Codeword cardamonite arrives through the write hook."),
        mimeType: "text/plain",
        createdBy: ANA,
      });
      let status: string | undefined;
      for (let i = 0; i < 100 && status !== "indexed"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        status = (await withWorkspaceScope(WS, (tx) => tx.searchText.findFirst({ where: { workspaceId: WS, fileId: file.id }, select: { status: true } })))?.status;
      }
      assert.equal(status, "indexed", "the hook indexed the file without an explicit call");
      assert.ok((await find("cardamonite")).hits.some((h) => h.id === file.id));
    } finally {
      process.env.SPOTLIGHT_INDEX_ON_WRITE = "off";
    }
  });
});
