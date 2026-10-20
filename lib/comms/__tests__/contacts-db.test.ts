// ShapesOS — Phase 18.2 (WS=comms) DB test: Contacts — the identity-link layer.
//   - the sync gives every record in the four stores its OWN identity and
//     never merges (suggestions only), and is idempotent;
//   - suggestions never cross workspaces; contact_* tables are FORCE RLS;
//   - a person's confirm merges (links stamped with who/when), a reject is
//     remembered (never suggested again, an agent's proposal is refused),
//     unlink takes a record back out and remembers it;
//   - Spotlight's "contact" kind returns ONE result per person;
//   - agent tools: suggest_merge never merges; confirm_merge asks without a rule.
// Real Postgres as the least-privilege app role.
// Run: DATABASE_URL=<app role> npx tsx --test lib/comms/__tests__/contacts-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ToolContext } from "@/lib/chat/tools";
import type { ChatToolCall } from "@/lib/chat/tool-exec";

const RUN = randomUUID().slice(0, 8);
const WS_A = `p182-con-a-${RUN}`;
const WS_B = `p182-con-b-${RUN}`;
const OWNER = `p182-con-owner-${RUN}`;
const EMAIL = `ana-${RUN}@acme-${RUN}.com`;

let prisma: typeof import("@/lib/prisma").prisma;
let rls: typeof import("@/lib/substrate/memory/rls");
let store: typeof import("../contacts/store");
type Tx = import("@prisma/client").Prisma.TransactionClient;
const inWs = <T,>(ws: string, fn: (tx: Tx) => Promise<T>) => rls.withWorkspaceScope(ws, (tx) => fn(tx as Tx));

const ids: Record<string, string> = {};

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  rls = await import("@/lib/substrate/memory/rls");
  store = await import("../contacts/store");
  for (const ws of [WS_A, WS_B]) {
    await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: OWNER } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws, userId: OWNER, role: "owner" } });
  }
  const pipeA = await prisma.pipeline.create({ data: { workspaceId: WS_A, name: "Sales", stages: [{ id: "new", label: "New" }] } });
  const pipeB = await prisma.pipeline.create({ data: { workspaceId: WS_B, name: "Sales", stages: [{ id: "new", label: "New" }] } });
  ids.lead = (await prisma.lead.create({ data: { workspaceId: WS_A, pipelineId: pipeA.id, name: "Ana Ruiz", email: EMAIL, company: "Acme" } })).id;
  ids.leadB = (await prisma.lead.create({ data: { workspaceId: WS_B, pipelineId: pipeB.id, name: "Ana Ruiz", email: EMAIL, company: "Acme" } })).id;
  await inWs(WS_A, async (tx) => {
    ids.contact = (await tx.opsContact.create({ data: { workspaceId: WS_A, name: "Ana Ruiz", email: EMAIL, notes: `Met at the zinfandel-${RUN} tasting` } })).id;
  });
  ids.person = (await prisma.connectorPerson.create({ data: { workspaceId: WS_A, name: "Ana Ruiz", handles: [EMAIL.toUpperCase()], consentedBy: OWNER } })).id;
  ids.funding = (await prisma.fundingContact.create({ data: { workspaceId: WS_A, name: "Bo Chen", handle: `bo-${RUN}@chen.vc` } })).id;
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  await prisma.$disconnect();
});

const pending = (ws: string) => inWs(ws, (tx) => store.listSuggestions(tx, { workspaceId: ws, status: "pending", limit: 100 }));

describe("sync: every record gets its own identity; suggestions only", () => {
  it("never merges on its own, is idempotent, and suggests the three Ana records", async () => {
    const r1 = await inWs(WS_A, (tx) => store.syncContactIdentities(tx, WS_A));
    assert.equal(r1.records, 4);
    assert.equal(r1.linked, 4);
    const identities = await inWs(WS_A, (tx) => tx.contactIdentity.findMany({ where: { workspaceId: WS_A } }));
    assert.equal(identities.length, 4, "one identity per record");
    assert.ok(identities.every((i) => i.recordCount === 1), "nothing merged automatically");
    const s = await pending(WS_A);
    assert.equal(s.items.length, 3, JSON.stringify(s.items.map((x) => [x.a.kind, x.b.kind, x.reasons])));
    assert.ok(s.items.every((x) => x.reasons.includes("email")));
    const r2 = await inWs(WS_A, (tx) => store.syncContactIdentities(tx, WS_A));
    assert.equal(r2.linked, 0);
    assert.equal(r2.suggested, 0);
    assert.equal((await pending(WS_A)).items.length, 3);
  });

  it("never crosses workspaces, and contact tables answer only inside their workspace (FORCE RLS)", async () => {
    await inWs(WS_B, (tx) => store.syncContactIdentities(tx, WS_B));
    assert.equal((await pending(WS_B)).items.length, 0, "B's single Ana has nothing to merge with");
    for (const s of (await pending(WS_A)).items) {
      assert.ok(![s.a.id, s.b.id].includes(ids.leadB!), "never B's lead");
    }
    assert.equal(await inWs(WS_B, (tx) => tx.contactIdentity.count({ where: { workspaceId: WS_A } })), 0, "RLS hides A's rows from B's scope");
    assert.equal(await prisma.contactIdentity.count({ where: { workspaceId: WS_A } }), 0, "no GUC, no rows");
  });
});

describe("a person decides", () => {
  it("confirm merges (stamped), reject is remembered, an agent can't re-propose it, unlink undoes", async () => {
    const all = (await pending(WS_A)).items;
    const leadContact = all.find((s) => [s.a.kind, s.b.kind].sort().join() === "lead,ops_contact")!;
    const { identityId } = await inWs(WS_A, (tx) => store.confirmSuggestion(tx, { workspaceId: WS_A, suggestionId: leadContact.id, userId: OWNER }));
    const detail = await inWs(WS_A, (tx) => store.getIdentityDetail(tx, WS_A, identityId));
    assert.deepEqual(detail.records.map((r) => r.kind).sort(), ["lead", "ops_contact"]);
    assert.ok(detail.records.every((r) => r.linkedVia === "merge" && r.confirmedAt));
    await assert.rejects(inWs(WS_A, (tx) => store.confirmSuggestion(tx, { workspaceId: WS_A, suggestionId: leadContact.id, userId: OWNER })), /already confirmed/);

    // The merged person vs the Network record: one pending pair after a sync.
    await inWs(WS_A, (tx) => store.syncContactIdentities(tx, WS_A));
    const left = (await pending(WS_A)).items;
    assert.equal(left.length, 1, JSON.stringify(left.map((x) => [x.a.kind, x.b.kind])));
    await inWs(WS_A, (tx) => store.rejectSuggestion(tx, { workspaceId: WS_A, suggestionId: left[0]!.id, userId: OWNER }));
    await inWs(WS_A, (tx) => store.syncContactIdentities(tx, WS_A));
    assert.equal((await pending(WS_A)).items.length, 0, "a rejection is never suggested again");
    const again = await inWs(WS_A, (tx) => store.proposeMerge(tx, { workspaceId: WS_A, a: { kind: "lead", id: ids.lead! }, b: { kind: "connector_person", id: ids.person! }, via: "agent" }));
    assert.equal(again.outcome, "previously_rejected");

    // Unlink the Ops contact: its own identity again, and the pair is remembered.
    const out = await inWs(WS_A, (tx) => store.unlinkRecord(tx, { workspaceId: WS_A, identityId, kind: "ops_contact", id: ids.contact!, userId: OWNER }));
    assert.notEqual(out.identityId, identityId);
    await inWs(WS_A, (tx) => store.syncContactIdentities(tx, WS_A));
    assert.equal((await pending(WS_A)).items.length, 0);
    // Re-link by hand for the next tests (a person's own merge: propose + confirm).
    const p = await inWs(WS_A, (tx) => tx.contactMergeSuggestion.deleteMany({ where: { workspaceId: WS_A, aKind: { in: ["lead", "ops_contact"] }, bKind: { in: ["lead", "ops_contact"] } } }));
    assert.ok(p.count >= 1);
    const proposed = await inWs(WS_A, (tx) => store.proposeMerge(tx, { workspaceId: WS_A, a: { kind: "lead", id: ids.lead! }, b: { kind: "ops_contact", id: ids.contact! }, via: "person" }));
    assert.equal(proposed.outcome, "proposed");
    await inWs(WS_A, (tx) => store.confirmSuggestion(tx, { workspaceId: WS_A, suggestionId: proposed.suggestion!.id, userId: OWNER }));
  });

  it("the timeline reads the linked records' activity", async () => {
    const pipe = await prisma.pipeline.findFirst({ where: { workspaceId: WS_A } });
    assert.ok(pipe);
    await prisma.outboundMessage.create({ data: { workspaceId: WS_A, leadId: ids.lead!, channel: "email", direction: "inbound", kind: "manual", subject: `Pricing question ${RUN}`, body: "Hi", status: "received" } });
    const identityId = await inWs(WS_A, (tx) => store.identityForRecord(tx, WS_A, "lead", ids.lead!));
    const d = await inWs(WS_A, (tx) => store.getIdentityDetail(tx, WS_A, identityId));
    assert.ok(d.timeline.some((e) => e.type === "mail" && e.title.includes(`Pricing question ${RUN}`)));

    // A cached Gmail thread is personal: it shows for its owner only.
    const conn = await prisma.connectorConnection.create({ data: { workspaceId: WS_A, connectorKey: "gmail", userId: OWNER, status: "active", scopes: [] } });
    await inWs(WS_A, (tx) =>
      tx.mailThreadCache.create({
        data: { workspaceId: WS_A, connectionId: conn.id, ownerUserId: OWNER, source: "gmail", externalId: `t-${RUN}`, latestMessageId: `m-${RUN}`, subject: `Private renewal ${RUN}`, participants: [EMAIL], lastMessageAt: new Date(), unread: false, labels: [] },
      }),
    );
    const own = await inWs(WS_A, (tx) => store.getIdentityDetail(tx, WS_A, identityId, OWNER));
    assert.ok(own.timeline.some((e) => e.title === `Private renewal ${RUN}`), "the owner sees their own thread");
    const other = await inWs(WS_A, (tx) => store.getIdentityDetail(tx, WS_A, identityId, `someone-else-${RUN}`));
    assert.ok(!other.timeline.some((e) => e.title === `Private renewal ${RUN}`), "a teammate never does");
    const anon = await inWs(WS_A, (tx) => store.getIdentityDetail(tx, WS_A, identityId));
    assert.ok(!anon.timeline.some((e) => e.title === `Private renewal ${RUN}`), "nor a caller with no viewer");
  });
});

describe("Spotlight: one result per person", () => {
  it("the contact kind returns the merged person once (and finds them by their Ops contact's notes)", async () => {
    const { spotlight } = await import("@/lib/search/records");
    const res = await spotlight(WS_A, "owner", "Ana Ruiz", { semantic: "off", kinds: ["contact"] });
    const contacts = res.hits.filter((h) => h.kind === "contact");
    const merged = await inWs(WS_A, (tx) => store.identityForRecord(tx, WS_A, "lead", ids.lead!));
    assert.equal(contacts.filter((h) => h.id === merged).length, 1);
    assert.ok(!contacts.some((h) => h.id === ids.contact), "the Ops contact is not a second result");
    assert.equal(contacts.find((h) => h.id === merged)!.href, `/dashboard/contacts/${merged}`);
    const byNote = await spotlight(WS_A, "owner", `zinfandel-${RUN}`, { semantic: "off", kinds: ["contact"] });
    assert.ok(byNote.hits.some((h) => h.id === merged), JSON.stringify(byNote.hits));
  });
});

describe("agent tools", () => {
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    projectId: `p182-noproject-${RUN}`,
    workspaceId: WS_A,
    userId: OWNER,
    role: "owner",
    confirmed: false,
    agentKey: "lead",
    grant: null,
    ...over,
  });
  const call = (tool: string, args: Record<string, unknown>): ChatToolCall => ({ tool, args, status: "pending_confirmation" });

  it("find_contact reads; suggest_merge only proposes; confirm_merge asks without a rule", async () => {
    const { executeTool } = await import("@/lib/chat/tool-exec");
    const find = call("find_contact", { query: "Ana" });
    const res = await executeTool(ctx(), "find_contact", find.args, find);
    assert.equal(find.status, "executed", find.resultSummary);
    assert.ok(((res?.details ?? []) as { name: string }[]).some((p) => p.name === "Ana Ruiz"));

    const bo = await prisma.lead.create({ data: { workspaceId: WS_A, pipelineId: (await prisma.pipeline.findFirst({ where: { workspaceId: WS_A } }))!.id, name: "Bo Chen", email: `bo-${RUN}@chen.vc` } });
    const before = await inWs(WS_A, (tx) => tx.contactIdentity.count({ where: { workspaceId: WS_A } }));
    const sug = call("suggest_merge", { recordA: `lead:${bo.id}`, recordB: `funding_contact:${ids.funding}` });
    await executeTool(ctx(), "suggest_merge", sug.args, sug);
    assert.equal(sug.status, "executed", sug.resultSummary);
    assert.match(sug.resultSummary ?? "", /Suggested/);
    const after = await inWs(WS_A, (tx) => tx.contactIdentity.count({ where: { workspaceId: WS_A } }));
    assert.equal(after, before + 1, "a new identity for the new lead — and no merge");
    const s = (await pending(WS_A)).items.find((x) => [x.a.id, x.b.id].includes(bo.id))!;
    assert.equal(s.proposedVia, "agent");

    const conf = call("confirm_merge", { suggestionId: s.id });
    await executeTool(ctx(), "confirm_merge", conf.args, conf);
    assert.equal(conf.status, "pending_confirmation", "Tier 1: asks unless a rule says auto");
    assert.equal(conf.autoAction, "confirm_contact_merge");
    const yes = call("confirm_merge", { suggestionId: s.id });
    await executeTool(ctx({ confirmed: true }), "confirm_merge", yes.args, yes);
    assert.equal(yes.status, "executed", yes.resultSummary);
    const merged = await inWs(WS_A, (tx) => store.identityForRecord(tx, WS_A, "lead", bo.id));
    assert.equal(merged, await inWs(WS_A, (tx) => store.identityForRecord(tx, WS_A, "funding_contact", ids.funding!)));
  });
});
