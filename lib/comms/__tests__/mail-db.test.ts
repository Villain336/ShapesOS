// ShapesOS — Phase 18.2 (WS=comms) DB test: the Mail app's unified inbox.
//   - it only shows this workspace's sources: the member's OWN mailboxes
//     (a teammate's mailbox never), this workspace's CRM conversations and
//     this workspace's Zernio DMs (never another workspace's, even on the
//     same Zernio team) — labelled mock rows in dev, never cached;
//   - cached thread headers carry the Mail app's own state (archive, read,
//     tags) — only the owner can change them; Spotlight "mail" is personal;
//   - a send still goes through the existing send action and the tier gate:
//     mail_send asks (send_outreach_email) unless a rule says auto; a viewer
//     can't reply to a lead; a social DM asks (send_social_dm) and lands on
//     the workspace's own account only.
// Real Postgres as the least-privilege app role; social DMs through the
// labelled FAKE Zernio (lib/zernio/fake.ts — MOCK, nothing leaves).
// Run: DATABASE_URL=<app role> npx tsx --test lib/comms/__tests__/mail-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ToolContext } from "@/lib/chat/tools";
import type { ChatToolCall } from "@/lib/chat/tool-exec";
import { FakeZernio } from "@/lib/zernio/fake";
import { clientForFake, setZernioClientForTests } from "@/lib/zernio/config";

const RUN = randomUUID().slice(0, 8);
const WS = `p182-mail-${RUN}`;
const WS_B = `p182-mail-b-${RUN}`;
const ANA = `p182-mail-ana-${RUN}`; // owner
const BEN = `p182-mail-ben-${RUN}`; // editor
const VI = `p182-mail-vi-${RUN}`; // viewer

const fake = new FakeZernio();
const client = clientForFake(fake);

let prisma: typeof import("@/lib/prisma").prisma;
let rls: typeof import("@/lib/substrate/memory/rls");
let mailbox: typeof import("../mail/mailbox.server");
type Tx = import("@prisma/client").Prisma.TransactionClient;
const inWs = <T,>(ws: string, fn: (tx: Tx) => Promise<T>) => rls.withWorkspaceScope(ws, (tx) => fn(tx as Tx));
const ctx = (userId: string, role: "owner" | "editor" | "viewer" = "owner", ws = WS) => ({ workspaceId: ws, userId, role });

const ids: Record<string, string> = {};

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  rls = await import("@/lib/substrate/memory/rls");
  mailbox = await import("../mail/mailbox.server");
  setZernioClientForTests(client);
  for (const ws of [WS, WS_B]) await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: ANA } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "owner" },
      { workspaceId: WS, userId: BEN, role: "editor" },
      { workspaceId: WS, userId: VI, role: "viewer" },
      { workspaceId: WS_B, userId: ANA, role: "owner" },
    ],
  });
  // Mailboxes: Ana's Outlook (dev mock — no credential), Ana's Gmail (no credential → error line), Ben's Outlook.
  ids.anaOutlook = (await prisma.connectorConnection.create({ data: { workspaceId: WS, connectorKey: "outlook", userId: ANA, status: "active", scopes: [], meta: { email: `ana-${RUN}@example.com` } } })).id;
  ids.anaGmail = (await prisma.connectorConnection.create({ data: { workspaceId: WS, connectorKey: "gmail", userId: ANA, status: "active", scopes: [] } })).id;
  ids.benOutlook = (await prisma.connectorConnection.create({ data: { workspaceId: WS, connectorKey: "outlook", userId: BEN, status: "active", scopes: [] } })).id;
  // A cached Gmail thread of Ana's (what a live refresh would have stored).
  await inWs(WS, (tx) =>
    tx.mailThreadCache.create({
      data: { workspaceId: WS, connectionId: ids.anaGmail!, ownerUserId: ANA, source: "gmail", externalId: `t-${RUN}`, latestMessageId: `m-${RUN}`, subject: `Zephyrine renewal ${RUN}`, fromName: "Ada", fromEmail: "ada@acme.com", participants: ["ada@acme.com"], lastMessageAt: new Date(), unread: true, labels: ["INBOX"] },
    }),
  );
  // CRM conversations in both workspaces.
  for (const ws of [WS, WS_B]) {
    const pipe = await prisma.pipeline.create({ data: { workspaceId: ws, name: "Sales", stages: [{ id: "new", label: "New" }] } });
    const lead = await prisma.lead.create({ data: { workspaceId: ws, pipelineId: pipe.id, name: ws === WS ? `Lena Lead ${RUN}` : `Other Lead ${RUN}`, email: `lead-${ws}@example.com` } });
    await prisma.outboundMessage.create({ data: { workspaceId: ws, leadId: lead.id, channel: "email", direction: "inbound", kind: "manual", subject: "Question", body: "Do you ship to Spain?", status: "received" } });
    if (ws === WS) ids.lead = lead.id;
  }
  // Zernio: a profile + an Instagram account for WS; another workspace's account on the same fake team.
  const { getZernioScope, syncZernioAccounts } = await import("@/lib/zernio/tenancy");
  const scope = await getZernioScope(WS, { client, userId: ANA });
  const ig = fake.connectAccount(scope.profileId, "instagram", { username: `shop_${RUN}` });
  await syncZernioAccounts(scope);
  ids.ig = ig._id;
  const other = fake.connectAccount("ffffffffffffffffffffffff", "instagram", { username: "someone_else" });
  fake.seedConversation(other._id, { participantName: `Stranger ${RUN}` });
  fake.seedConversation(ig._id, { participantName: `Customer ${RUN}`, messages: [{ text: "Is the blue one in stock?" }] });
});

after(async () => {
  setZernioClientForTests(null);
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_B] } } });
  await prisma.$disconnect();
});

describe("the unified inbox only shows this workspace's sources", () => {
  it("own mailboxes (mock labelled, a teammate's never), this workspace's CRM and DMs", async () => {
    const l = await mailbox.listMailbox(ctx(ANA), { refresh: true });
    const keys = l.threads.map((t) => t.key);
    assert.ok(l.threads.some((t) => t.source === "outlook" && t.mock && t.key.includes(ids.anaOutlook!)), "Ana's Outlook (dev mock), labelled");
    assert.ok(!keys.some((k) => k.includes(ids.benOutlook!)), "never Ben's mailbox");
    assert.ok(l.threads.some((t) => t.source === "gmail" && t.subject === `Zephyrine renewal ${RUN}`), "cached Gmail headers");
    assert.ok(l.sources.find((s) => s.source === "gmail")?.error, "Gmail has no credential: shown as an error line, not hidden");
    assert.ok(l.threads.some((t) => t.source === "crm" && t.subject === `Lena Lead ${RUN}`));
    assert.ok(!l.threads.some((t) => t.subject === `Other Lead ${RUN}`), "never another workspace's CRM");
    const dms = l.threads.filter((t) => t.source === "social");
    assert.ok(dms.some((t) => t.subject === `Customer ${RUN}` && t.mock), "this workspace's DM, labelled mock");
    assert.ok(!dms.some((t) => t.subject.includes("Stranger")), "never another tenant's DM on the same Zernio team");
    assert.equal(await inWs(WS, (tx) => tx.mailThreadCache.count({ where: { connectionId: ids.anaOutlook! } })), 0, "mock rows are never cached");

    const ben = await mailbox.listMailbox(ctx(BEN, "editor"), {});
    assert.ok(!ben.threads.some((t) => t.subject === `Zephyrine renewal ${RUN}`), "Ana's Gmail is personal");
    const other = await mailbox.listMailbox(ctx(ANA, "owner", WS_B), {});
    assert.ok(!other.threads.some((t) => t.source === "social"), "workspace B has no Zernio profile: no DMs");
    assert.ok(other.threads.some((t) => t.subject === `Other Lead ${RUN}`));
  });

  it("opening a DM reads it from Zernio and marks it read there", async () => {
    const key = `social:${ids.ig}:${[...fake.conversations.values()].find((c) => c.conv.accountId === ids.ig)!.conv.id}`;
    const d = await mailbox.readMailThread(ctx(ANA), key, { markRead: true });
    assert.ok(d.messages.some((m) => m.body === "Is the blue one in stock?" && m.direction === "inbound"));
    assert.ok(fake.calls.some((c) => c.operationId === "markConversationRead"));
    const strangerKey = `social:${[...fake.conversations.values()].find((c) => c.conv.participantName?.startsWith("Stranger"))!.conv.accountId}:x`;
    await assert.rejects(mailbox.readMailThread(ctx(ANA), strangerKey), /not connected to this workspace/);
  });
});

describe("the Mail app's own state", () => {
  it("archive, read, tags on a cached thread — only by its owner; Spotlight mail is personal", async () => {
    const key = `gmail:${ids.anaGmail}:t-${RUN}`;
    let t = await mailbox.organizeThread(ctx(ANA), key, { archived: true, unread: false, addTags: ["billing"] });
    assert.deepEqual([t.archived, t.unread, t.tags], [true, false, ["billing"]]);
    const archived = await mailbox.listMailbox(ctx(ANA), { folder: "archived", source: "gmail" });
    assert.ok(archived.threads.some((x) => x.key === key));
    assert.ok(!(await mailbox.listMailbox(ctx(ANA), { source: "gmail" })).threads.some((x) => x.key === key), "out of the inbox");
    await assert.rejects(mailbox.organizeThread(ctx(BEN, "editor"), key, { archived: false }), /not found/i);
    t = await mailbox.organizeThread(ctx(ANA), key, { archived: false, removeTags: ["billing"] });
    assert.deepEqual(t.tags, []);

    const { spotlight } = await import("@/lib/search/records");
    const mine = await spotlight(WS, "owner", "Zephyrine", { semantic: "off", userId: ANA, kinds: ["mail"] } as never);
    assert.ok(mine.hits.some((h) => h.kind === "mail" && h.href.includes(encodeURIComponent(key))), JSON.stringify(mine.hits));
    const ben = await spotlight(WS, "editor", "Zephyrine", { semantic: "off", userId: BEN, kinds: ["mail"] } as never);
    assert.equal(ben.hits.filter((h) => h.kind === "mail").length, 0, "never a teammate's mail");
  });
});

describe("sending goes through the existing send actions and the tier gate", () => {
  const tctx = (over: Partial<ToolContext> = {}): ToolContext => ({ projectId: `p182-np-${RUN}`, workspaceId: WS, userId: ANA, role: "owner", confirmed: false, agentKey: "drafter", grant: ["workspace", "email", "social"], ...over });
  const call = (tool: string, args: Record<string, unknown>): ChatToolCall => ({ tool, args, status: "pending_confirmation" });

  it("mail_send asks (send_outreach_email) without a rule; runs under one; mock sends nothing", async () => {
    const { executeTool } = await import("@/lib/chat/tool-exec");
    const args = { connectionId: ids.anaOutlook, to: "ada@example.com", subject: "Hello", body: "Hi Ada" };
    const asks = call("mail_send", args);
    await executeTool(tctx(), "mail_send", args, asks);
    assert.equal(asks.status, "pending_confirmation");
    assert.equal(asks.autoAction, "send_outreach_email");
    await inWs(WS, (tx) => tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "drafter", action: "send_outreach_email", behavior: "auto", updatedBy: ANA } }));
    const runs = call("mail_send", args);
    await executeTool(tctx(), "mail_send", args, runs);
    assert.equal(runs.status, "executed", runs.resultSummary);
    assert.match(runs.resultSummary ?? "", /MOCK/);
    await inWs(WS, (tx) => tx.automationSetting.deleteMany({ where: { workspaceId: WS, action: "send_outreach_email" } }));
  });

  it("a person's send: their own mailbox only; a viewer can't reply to a lead; a CRM reply goes through the dispatcher", async () => {
    const { sendMail } = await import("../mail/send.server");
    const out = await sendMail({ workspaceId: WS, userId: ANA, role: "owner", by: "person" }, { connectionId: ids.anaOutlook, to: "ada@example.com", subject: "Hi", body: "Hello" });
    assert.equal(out.outcome, "mock");
    assert.equal(await prisma.fileChangeLog.count({ where: { workspaceId: WS, action: "mail_sent" } }), 1);
    await assert.rejects(sendMail({ workspaceId: WS, userId: ANA, role: "owner", by: "person" }, { connectionId: ids.benOutlook, to: "x@example.com", subject: "x", body: "x" }), /not connected to your account/);
    await assert.rejects(sendMail({ workspaceId: WS, userId: VI, role: "viewer", by: "person" }, { threadKey: `crm:${ids.lead}`, body: "Yes we do", channel: "email", subject: "Re: Question" }), /Editors and above/);
    const before = await prisma.outboundMessage.count({ where: { workspaceId: WS, leadId: ids.lead, direction: "outbound" } });
    const crm = await sendMail({ workspaceId: WS, userId: BEN, role: "editor", by: "person" }, { threadKey: `crm:${ids.lead}`, body: "Yes we do", channel: "email", subject: "Re: Question" });
    assert.ok(["queued", "suppressed", "sent", "failed"].includes(crm.outcome), crm.outcome);
    assert.equal(await prisma.outboundMessage.count({ where: { workspaceId: WS, leadId: ids.lead, direction: "outbound" } }), before + 1, "one ledger row, through the dispatcher's gates");
  });

  it("a social DM asks first (send_social_dm) and lands on the workspace's own account", async () => {
    const { executeTool } = await import("@/lib/chat/tool-exec");
    const conv = [...fake.conversations.values()].find((c) => c.conv.accountId === ids.ig)!;
    const key = `social:${ids.ig}:${conv.conv.id}`;
    const asks = call("social_send_dm", { key, text: "Yes, in stock!" });
    await executeTool(tctx(), "social_send_dm", asks.args, asks);
    assert.equal(asks.status, "pending_confirmation");
    assert.equal(asks.autoAction, "send_social_dm");
    assert.ok(!conv.messages.some((m) => m.message === "Yes, in stock!"), "nothing sent while it asks");
    const yes = call("social_send_dm", { key, text: "Yes, in stock!" });
    await executeTool(tctx({ confirmed: true }), "social_send_dm", yes.args, yes);
    assert.equal(yes.status, "executed", yes.resultSummary);
    assert.ok(conv.messages.some((m) => m.message === "Yes, in stock!" && m.direction === "outgoing"));
    const send = fake.calls.filter((c) => c.operationId === "sendInboxMessage").at(-1)!;
    assert.ok(send.idempotencyKey, "sent with an Idempotency-Key");
  });
});
