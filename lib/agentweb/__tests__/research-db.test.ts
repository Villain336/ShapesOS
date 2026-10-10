// Phase 21A round 2 (WS=agentweb), M6: research workspace and browsing memory on real Postgres as
// the app role (FORCE RLS), through the real stores, routes' logic, Spotlight and executeTool.
//   - browsing memory is OFF by default; on, it remembers only pages the person asked to read,
//     keyed without the query string, never an excluded site (existing items from a newly excluded
//     site are forgotten), never a private address; per-item forget; retention expiry; a member's
//     memory is theirs alone (not another member's, not another workspace's), also in Spotlight
//     (kind page_memory) and therefore in the answer engine's workspace source;
//   - a research session is its owner's until shared (editor+); a shared one shows the web research
//     but never the owner's private workspace records; export = Markdown + signed receipts + seal;
//   - attaching a page by address stores a signed receipt, and a site that says no is a typed outcome;
//   - follow-up answers attach (owner only); a linked browsing session's steps are remembered live;
//   - "Clip to…" runs the existing tools through executeTool (editor+), the graph clip appends a fact;
//   - a page monitor starts its linked workflow as the person who linked it, and says why when it cannot;
//   - FORCE RLS on all five new tables.
// Listed in scripts/test/db-tests.txt.
import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");
process.env.MARKETR_STORAGE ||= "local";
process.env.SPOTLIGHT_INDEX_ON_WRITE = "off";
process.env.AGENTWEB_RECEIPT_SECRET ||= "test-receipt-secret-for-research";

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { settleBackgroundWork } from "@/lib/runtime/shutdown";
import { spotlight } from "@/lib/search/records";
import { storeCapture } from "../captures-store";
import { receiptSecret, signCapture, captureOf } from "../receipts";
import { forgetAll, forgetItem, getMemorySettings, listMemory, purgeExpiredMemory, rememberPage, saveMemorySettings } from "../memory/store";
import { handleMemoryOp } from "../memory/route-core";
import { addPageToResearch } from "../research/page";
import { attachAnswer, backfillFromRun, createResearch, exportResearch, getResearch, listResearch, rememberFromRunStep, removeResearch, ResearchError, updateResearch } from "../research/store";
import { handleResearchOp } from "../research/route-core";
import { fireMonitorTriggers, linkMonitor, listMonitorLinks, MonitorLinkError, unlinkMonitor } from "../research/monitors";
import { verifySeal } from "../research/view";
import "@/lib/notes/tools";
import "@/lib/documents/tools";

const RUN = randomUUID().slice(0, 8);
const WS = `p21rs-${RUN}`;
const OTHER = `p21rs-o-${RUN}`;
const ANA = `p21rs-ana-${RUN}`; // owner, editor
const BEN = `p21rs-ben-${RUN}`; // teammate, editor
const VIV = `p21rs-viv-${RUN}`; // viewer
let projectId = "";

const req = (body: unknown) => new Request("https://app.test/api/agentweb/research", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", origin: "https://app.test" }, body: JSON.stringify(body) });
const ana = { userId: ANA, workspaceId: WS, role: "editor" };
const ben = { userId: BEN, workspaceId: WS, role: "editor" };
const viv = { userId: VIV, workspaceId: WS, role: "viewer" };

async function makeAnswer(userId: string, question: string, sources: Array<{ url: string; title: string; text: string; provider: string }>): Promise<string> {
  const id = `ans_${randomBytes(6).toString("hex")}`;
  const stored: Array<Record<string, unknown>> = [];
  for (const [i, s] of sources.entries()) {
    const cap = signCapture(captureOf({ url: s.url, html: s.text, text: s.text, fetchedAt: new Date() }), receiptSecret());
    await storeCapture(WS, cap, { via: "search-snippet", provider: s.provider, answerId: id, bodyText: s.text, retentionDays: 5 });
    stored.push({ id: i + 1, url: s.url, title: s.title, text: s.text, providers: [s.provider], trust: 1, freshness: 1, score: 1, captureId: cap.id });
  }
  const payload = {
    question,
    plan: { kind: "lookup", use: ["web"], queries: [question], recent: false, by: "rules" },
    claims: stored.map((s, i) => ({ text: `${String(s.title)} says: ${String(s.text)}`, cites: [i + 1], evidence: [String(s.text)], status: "supported", supportedBy: [i + 1] })),
    sources: stored,
    followUps: [],
    notes: [],
    partial: false,
    writtenBy: "model",
  };
  await withWorkspaceScope(WS, (tx) => tx.webAnswer.create({ data: { id, workspaceId: WS, userId, question, payload: payload as never, captureIds: stored.map((s) => String(s.captureId)) } }));
  return id;
}

before(async () => {
  for (const id of [WS, OTHER]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: ANA, plan: "pro" } });
  for (const [userId, role] of [[ANA, "editor"], [BEN, "editor"], [VIV, "viewer"]] as const) await prisma.workspaceMember.create({ data: { workspaceId: WS, userId, role } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
});
after(async () => {
  await settleBackgroundWork();
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, OTHER] } } });
  await prisma.$disconnect();
});

describe("browsing memory", () => {
  it("is off until the member turns it on: nothing is stored", async () => {
    const d = await rememberPage(WS, ANA, { url: "https://news.test/a", title: "A", text: "hello", askedByPerson: true });
    assert.deepEqual(d, { store: false, reason: "off" });
    assert.equal((await listMemory(WS, ANA)).length, 0);
    assert.deepEqual(await getMemorySettings(WS, ANA), { enabled: false, retentionDays: 30, excludedSites: [] });
  });

  it("remembers what the person asked for, without the query string, and counts repeats", async () => {
    await saveMemorySettings(WS, ANA, { enabled: true, retentionDays: 10 });
    assert.equal((await rememberPage(WS, ANA, { url: "https://news.test/a?q=secret-term#top", title: "Story A", text: "The story text", askedByPerson: true })).store, true);
    await rememberPage(WS, ANA, { url: "https://news.test/a", title: "Story A", text: "The story text again", askedByPerson: true });
    const items = await listMemory(WS, ANA);
    assert.equal(items.length, 1);
    assert.equal(items[0].url, "https://news.test/a");
    assert.equal(items[0].seenCount, 2);
    assert.ok(!JSON.stringify(items).includes("secret-term"));
    const days = (Date.parse(items[0].retentionUntil) - Date.now()) / 86_400_000;
    assert.ok(days > 9 && days <= 10.01, `retention ${days}`);
  });

  it("not for what the person did not ask the agent to read, a private address, or an excluded site", async () => {
    assert.deepEqual(await rememberPage(WS, ANA, { url: "https://other.test/x", title: "X", text: "x", askedByPerson: false }), { store: false, reason: "not_asked" });
    assert.equal((await rememberPage(WS, ANA, { url: "http://192.168.1.2/admin", title: "R", text: "x", askedByPerson: true })).store, false);
    await saveMemorySettings(WS, ANA, { excludedSites: ["bank.test"] });
    assert.deepEqual(await rememberPage(WS, ANA, { url: "https://app.bank.test/accounts", title: "Bank", text: "balance", askedByPerson: true }), { store: false, reason: "excluded" });
  });

  it("excluding a site also forgets what was already remembered from it", async () => {
    await rememberPage(WS, ANA, { url: "https://health.test/clinic", title: "Clinic", text: "appointment", askedByPerson: true });
    assert.equal((await listMemory(WS, ANA)).some((i) => i.url.includes("health.test")), true);
    const out = await saveMemorySettings(WS, ANA, { excludedSites: ["bank.test", "health.test"] });
    assert.equal(out.forgotten, 1);
    assert.equal((await listMemory(WS, ANA)).some((i) => i.url.includes("health.test")), false);
  });

  it("is the member's own: a teammate neither sees nor forgets it, and their own settings are separate", async () => {
    assert.equal((await listMemory(WS, BEN)).length, 0);
    const mine = (await listMemory(WS, ANA))[0];
    assert.equal(await forgetItem(WS, BEN, mine.id), false);
    assert.equal((await listMemory(WS, ANA)).length, 1);
    assert.equal((await getMemorySettings(WS, BEN)).enabled, false);
  });

  it("is findable in Spotlight by its owner only (and so by the answer engine as that owner)", async () => {
    await rememberPage(WS, ANA, { url: "https://wiki.test/boots-guide", title: "Boots buying guide", text: "Waterproof leather hiking boots compared", askedByPerson: true });
    const own = await spotlight(WS, "editor", "boots", { userId: ANA, perKind: 5, semantic: "off" });
    assert.ok(own.hits.some((h) => h.kind === "page_memory" && h.title === "Boots buying guide"), JSON.stringify(own.hits.map((h) => h.kind)));
    const byWord = await spotlight(WS, "editor", "waterproof leather", { userId: ANA, perKind: 5, semantic: "off" });
    assert.ok(byWord.hits.some((h) => h.kind === "page_memory"), "found by the words in the excerpt");
    const teammate = await spotlight(WS, "editor", "boots", { userId: BEN, perKind: 5, semantic: "off" });
    assert.ok(!teammate.hits.some((h) => h.kind === "page_memory"));
    const noUser = await spotlight(WS, "owner", "boots", { perKind: 5, semantic: "off" });
    assert.ok(!noUser.hits.some((h) => h.kind === "page_memory"));
    const otherWs = await spotlight(OTHER, "owner", "boots", { userId: ANA, perKind: 5, semantic: "off" });
    assert.ok(!otherWs.hits.some((h) => h.kind === "page_memory"));
  });

  it("forgetting an item removes it from the list and from Spotlight; retention expires the rest", async () => {
    const item = (await listMemory(WS, ANA, { q: "boots" }))[0];
    assert.equal(await forgetItem(WS, ANA, item.id), true);
    const after1 = await spotlight(WS, "editor", "boots", { userId: ANA, perKind: 5, semantic: "off" });
    assert.ok(!after1.hits.some((h) => h.kind === "page_memory"));
    await rememberPage(WS, ANA, { url: "https://old.test/p", title: "Old page", text: "old", askedByPerson: true });
    await withWorkspaceScope(WS, (tx) => tx.agentwebMemory.updateMany({ where: { userId: ANA, url: "https://old.test/p" }, data: { retentionUntil: new Date(Date.now() - 1000) } }));
    assert.equal((await listMemory(WS, ANA)).some((i) => i.url.includes("old.test")), false, "an expired item is not listed");
    const gone = await spotlight(WS, "editor", "old page", { userId: ANA, perKind: 5, semantic: "off" });
    assert.ok(!gone.hits.some((h) => h.kind === "page_memory"), "nor found");
    assert.ok((await purgeExpiredMemory(WS)) >= 1);
  });

  it("the route needs a same-origin JSON request and acts only on the signed-in member's own memory", async () => {
    const cross = await handleMemoryOp({ userId: ANA, workspaceId: WS }, new Request("https://app.test/api/agentweb/memory", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" }));
    assert.equal(cross.status, 403);
    const r = await handleMemoryOp({ userId: BEN, workspaceId: WS }, req({ op: "forget_all" }));
    assert.equal(r.status, 200);
    assert.ok((await listMemory(WS, ANA)).length >= 1, "Ben's forget-all did not touch Ana's memory");
    assert.equal((await handleMemoryOp({ userId: ANA, workspaceId: WS }, req({ op: "forget_site", site: "not a site" }))).status, 400);
    assert.equal((await forgetAll(WS, ANA)) >= 1, true);
  });
});

describe("research sessions", () => {
  let rid = "";
  let answerId = "";
  it("a session starts private to its owner", async () => {
    answerId = await makeAnswer(ANA, "How much do boots cost?", [
      { url: "https://shop.test/boots", title: "Boots shop", text: "Boots cost 80 dollars.", provider: "brave" },
      { url: "/dashboard/notes?note=n1", title: "Margin note", text: "Internal margin is 40 percent.", provider: "workspace" },
    ]);
    const created = await createResearch(WS, ANA, { question: "How much do boots cost?", answerId });
    rid = created.id;
    assert.equal(created.answers, 1);
    assert.equal(created.shareState, "private");
    assert.equal(await getResearch(WS, BEN, rid), null, "private is private");
    assert.equal((await listResearch(WS, BEN)).some((r) => r.id === rid), false);
  });

  it("attaching an answer remembers its web sources when memory is on, never a workspace record", async () => {
    await saveMemorySettings(WS, ANA, { enabled: true, excludedSites: [] });
    await attachAnswer(WS, ANA, rid, answerId);
    const mem = await listMemory(WS, ANA);
    assert.ok(mem.some((m) => m.url === "https://shop.test/boots" && m.researchId === rid));
    assert.ok(!mem.some((m) => m.url.includes("/dashboard/notes")));
  });

  it("attaching is the owner's alone, and only their own answers", async () => {
    const bens = await makeAnswer(BEN, "Ben's question about cats", [{ url: "https://cats.test/", title: "Cats", text: "Cats purr.", provider: "brave" }]);
    await assert.rejects(attachAnswer(WS, ANA, rid, bens), ResearchError);
    await assert.rejects(attachAnswer(WS, BEN, rid, answerId), ResearchError);
  });

  it("sharing needs the editor role; a teammate then sees the web research but not the owner's private records", async () => {
    await assert.rejects(updateResearch(WS, VIV, "viewer", rid, { shareState: "workspace" }), ResearchError);
    const viewer = await createResearch(WS, VIV, { question: "A viewer's question" });
    await assert.rejects(updateResearch(WS, VIV, "viewer", viewer.id, { shareState: "workspace" }), /editor role/);
    await updateResearch(WS, ANA, "editor", rid, { shareState: "workspace", notes: "Check the size chart." });
    const seen = (await getResearch(WS, BEN, rid))!;
    assert.equal(seen.owner, false);
    assert.equal(seen.notes, "Check the size chart.");
    assert.equal(seen.answers[0].sources[1].redacted, true);
    assert.equal(seen.answers[0].sources[1].url, "");
    assert.ok(!JSON.stringify(seen).includes("Internal margin"), "no workspace record text reaches a teammate");
    assert.ok(!JSON.stringify(seen).includes("/dashboard/notes"));
    const own = (await getResearch(WS, ANA, rid, { includeWorkspace: true }))!;
    assert.ok(JSON.stringify(own).includes("Internal margin"));
    // a teammate cannot change it
    await assert.rejects(updateResearch(WS, BEN, "editor", rid, { title: "Hijacked" }), /Only the person who started/);
    const forbidden = await handleResearchOp(ben, req({ op: "remove", id: rid }));
    assert.equal(forbidden.status, 403);
  });

  it("exports Markdown with signed receipts and a seal; the owner's private records stay out unless asked", async () => {
    const b = (await exportResearch(WS, ANA, rid))!;
    assert.match(b.markdown, /Boots cost 80 dollars\./);
    assert.ok(!b.markdown.includes("Internal margin"));
    assert.deepEqual(b.receipts.map((r) => r.url), ["https://shop.test/boots"]);
    assert.equal(b.receipts[0].alg, "hmac-sha256");
    assert.ok(b.seal, "sealed");
    assert.equal(verifySeal(b, receiptSecret()!), true);
    assert.equal(verifySeal({ ...b, markdown: b.markdown.replace("80", "90") }, receiptSecret()!), false);
    const withWs = (await exportResearch(WS, ANA, rid, { includeWorkspace: true }))!;
    assert.match(withWs.markdown, /Internal margin|Margin note/);
    const mates = (await exportResearch(WS, BEN, rid, { includeWorkspace: true }))!;
    assert.ok(!mates.markdown.includes("Margin note"), "a teammate cannot ask for the owner's workspace records");
  });

  it("a page attached by address is read like the answer engine reads one and stored as a signed receipt", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
      return new Response("<html><title>Size chart</title><body><p>Boots run half a size small.</p></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    };
    const res = await addPageToResearch(WS, ANA, rid, "https://sizes.test/chart?utm=abc", { fetchFn, resolve: async () => ["93.184.216.34"], signer: null });
    assert.equal(res.ok, true);
    const view = (await getResearch(WS, ANA, rid, { includeWorkspace: true }))!;
    assert.ok(view.pages.some((p) => p.url.startsWith("https://sizes.test/chart") && p.excerpt.includes("half a size small")));
    assert.ok(view.receipts.some((r) => r.url.startsWith("https://sizes.test/chart") && r.alg === "hmac-sha256"));
    assert.ok((await listMemory(WS, ANA)).some((m) => m.url === "https://sizes.test/chart"), "remembered without the query string");
  });

  it("a site that says no is a typed outcome and nothing is stored", async () => {
    const blocked: typeof fetch = async (input) => {
      if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response("Just a moment...", { status: 403, headers: { "cf-mitigated": "challenge", "content-type": "text/html" } });
    };
    const before = (await getResearch(WS, ANA, rid, { includeWorkspace: true }))!.pages.length;
    const res = await addPageToResearch(WS, ANA, rid, "https://walled.test/", { fetchFn: blocked, resolve: async () => ["93.184.216.34"], signer: null });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.outcome.kind, "blocked_by_site");
    assert.equal((await getResearch(WS, ANA, rid, { includeWorkspace: true }))!.pages.length, before);
    const robots: typeof fetch = async (input) => (String(input).endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /", { status: 200 }) : new Response("never fetched", { status: 200 }));
    const r2 = await addPageToResearch(WS, ANA, rid, "https://closed.test/page", { fetchFn: robots, resolve: async () => ["93.184.216.34"], signer: null });
    assert.equal(!r2.ok && r2.outcome.kind, "disallowed_by_robots");
  });

  it("an address in the private range is refused by the same guard as the answer engine", async () => {
    const res = await addPageToResearch(WS, ANA, rid, "http://127.0.0.1:3000/admin", {});
    assert.equal(res.ok, false);
  });

  it("a follow-up answer attaches to the session through the answer route's logic", async () => {
    const follow = await makeAnswer(ANA, "And how about shipping?", [{ url: "https://ship.test/rates", title: "Shipping", text: "Shipping is 5 dollars.", provider: "brave" }]);
    await attachAnswer(WS, ANA, rid, follow);
    const v = (await getResearch(WS, ANA, rid, { includeWorkspace: true }))!;
    assert.equal(v.answers.length, 2);
    assert.deepEqual(v.answers.map((a) => a.question), ["How much do boots cost?", "And how about shipping?"]);
  });

  it("a linked browsing session's steps are remembered live, only for its owner", async () => {
    const runId = `${RUN}-run1`;
    await withWorkspaceScope(WS, (tx) => tx.agentRun.create({ data: { id: runId, workspaceId: WS, kind: "chat", status: "running", startedBy: ANA, threadId: `${runId}-t`, agentKey: "lead" } }));
    await assert.rejects(updateResearch(WS, BEN, "editor", rid, { runId }), ResearchError);
    const otherRun = `${RUN}-run2`;
    await withWorkspaceScope(WS, (tx) => tx.agentRun.create({ data: { id: otherRun, workspaceId: WS, kind: "chat", status: "running", startedBy: BEN, threadId: `${otherRun}-t`, agentKey: "lead" } }));
    await assert.rejects(updateResearch(WS, ANA, "editor", rid, { runId: otherRun }), /you did not start/);
    await updateResearch(WS, ANA, "editor", rid, { runId });
    await rememberFromRunStep(WS, ANA, runId, { url: "https://live.test/page?x=1", text: "Read during the session", captureId: "cap_x" });
    assert.ok((await listMemory(WS, ANA)).some((m) => m.url === "https://live.test/page" && m.runId === runId));
    // a run nobody linked remembers nothing
    await rememberFromRunStep(WS, ANA, otherRun, { url: "https://unlinked.test/page", text: "x", captureId: "cap_y" });
    assert.ok(!(await listMemory(WS, ANA)).some((m) => m.url.includes("unlinked.test")));
    assert.equal(typeof (await backfillFromRun(WS, ANA, rid, runId)), "number");
  });

  it("Clip to… runs the existing tools through executeTool (editor+); the graph clip appends a business fact", async () => {
    const note = await handleResearchOp(ana, req({ op: "clip", id: rid, target: "note" }));
    const nb = (await note.json()) as { status: string; summary: string };
    assert.equal(nb.status, "executed", nb.summary);
    assert.match(nb.summary, /Saved the note/);
    const n = await withWorkspaceScope(WS, (tx) => tx.univerDoc.findFirst({ where: { workspaceId: WS, kind: "note" }, orderBy: { createdAt: "desc" } }));
    assert.ok(n && /Research/.test(n.title ?? ""), "a note exists");
    assert.equal((await handleResearchOp(viv, req({ op: "clip", id: rid, target: "note" }))).status, 403);
    assert.equal((await handleResearchOp(ana, req({ op: "clip", id: rid, target: "contact" }))).status, 400, "a contact needs a name");
    const g = await handleResearchOp(ana, req({ op: "clip", id: rid, target: "graph", url: "https://shop.test/boots" }));
    assert.equal(g.status, 200);
    const facts = await withWorkspaceScope(WS, (tx) => tx.graphFact.findMany({ where: { workspaceId: WS, source: "agentweb-clip" } }));
    assert.equal(facts.length, 1);
    assert.equal(facts[0].entityRef, "content:https://shop.test/boots");
    // a clip of a page that is not in the research is refused
    assert.equal((await handleResearchOp(ana, req({ op: "clip", id: rid, target: "graph", url: "https://not-in-research.test/" }))).status, 400);
    // a teammate cannot clip someone else's private research; the shared one clips only what it shows them
    assert.equal((await handleResearchOp(ben, req({ op: "clip", id: "nope", target: "note" }))).status, 404);
  });

  it("removing a session removes its attachments, not the answers or receipts", async () => {
    await assert.rejects(removeResearch(WS, BEN, rid), ResearchError);
    await removeResearch(WS, ANA, rid);
    assert.equal(await getResearch(WS, ANA, rid), null);
    assert.equal(await withWorkspaceScope(WS, (tx) => tx.agentwebResearchItem.count({ where: { researchId: rid } })), 0);
    assert.ok(await withWorkspaceScope(WS, (tx) => tx.webAnswer.findUnique({ where: { id: answerId } })), "the answer is still there");
  });
});

describe("page monitors that start workflows", () => {
  let monitorId = "";
  let workflowId = "";
  before(async () => {
    monitorId = (await prisma.monitor.create({ data: { workspaceId: WS, name: "Price page", url: "https://shop.test/price", cadence: "daily" } })).id;
    workflowId = (await prisma.workflow.create({ data: { projectId, name: "Tell me", createdBy: ANA, status: "draft", enabled: true } })).id;
  });

  it("an editor links a monitor to a workflow; a viewer cannot; the other workspace's monitor is not found", async () => {
    await assert.rejects(linkMonitor(WS, VIV, "viewer", monitorId, workflowId), MonitorLinkError);
    await assert.rejects(linkMonitor(WS, ANA, "editor", "nope", workflowId), /not found/);
    const l = await linkMonitor(WS, ANA, "editor", monitorId, workflowId);
    assert.equal(l.workflowName, "Tell me");
    assert.equal((await listMonitorLinks(WS)).length, 1);
    assert.equal((await listMonitorLinks(OTHER)).length, 0);
  });

  it("a change starts the workflow as the person who linked it, with the change as trigger data", async () => {
    const started: Array<Record<string, unknown>> = [];
    const n = await fireMonitorTriggers(WS, { monitorId, name: "Price page", url: "https://shop.test/price", changeId: "chg1", digest: "+ new price 79", excerpt: "now 79 dollars" }, { start: (async (a: Record<string, unknown>) => { started.push(a); return { run: {}, deduped: false }; }) as never });
    assert.equal(n, 1);
    assert.equal(started[0].createdBy, ANA);
    assert.equal(started[0].workflowId, workflowId);
    assert.deepEqual((started[0].payload as { digest: string }).digest, "+ new price 79");
    const link = (await listMonitorLinks(WS))[0];
    assert.equal(link.firedCount, 1);
    assert.equal(link.lastError, null);
  });

  it("a workflow that is not switched on is not started, and the link says why", async () => {
    const n = await fireMonitorTriggers(WS, { monitorId, name: "Price page", url: "https://shop.test/price", changeId: "chg2", digest: "d", excerpt: null });
    assert.equal(n, 0);
    const link = (await listMonitorLinks(WS))[0];
    assert.match(link.lastError ?? "", /not active/);
  });

  it("a person who is no longer an editor cannot be acted as: the link switches itself off", async () => {
    await prisma.workspaceMember.updateMany({ where: { workspaceId: WS, userId: ANA }, data: { role: "viewer" } });
    const n = await fireMonitorTriggers(WS, { monitorId, name: "Price page", url: "https://shop.test/price", changeId: "chg3", digest: "d", excerpt: null }, { start: (async () => { throw new Error("must not start"); }) as never });
    assert.equal(n, 0);
    const link = (await listMonitorLinks(WS))[0];
    assert.equal(link.enabled, false);
    assert.match(link.lastError ?? "", /no longer an editor/);
    await prisma.workspaceMember.updateMany({ where: { workspaceId: WS, userId: ANA }, data: { role: "editor" } });
  });

  it("unlinking removes it", async () => {
    assert.equal(await unlinkMonitor(WS, "editor", monitorId, workflowId), true);
    assert.equal((await listMonitorLinks(WS)).length, 0);
  });
});

describe("FORCE RLS on the new tables", () => {
  const TABLES = ["agentweb_research", "agentweb_research_items", "agentweb_memory_settings", "agentweb_memory", "agentweb_monitor_triggers"];
  it("with no workspace set every table is empty, and a write is refused", async () => {
    await createResearch(WS, ANA, { question: "A question for the RLS test" });
    await rememberPage(WS, ANA, { url: "https://rls.test/x", title: "R", text: "x", askedByPerson: true });
    for (const t of TABLES) {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM ${t}`);
      assert.equal(Number(rows[0].n), 0, `${t} shows rows without a workspace`);
    }
    await assert.rejects(prisma.$executeRawUnsafe(`INSERT INTO agentweb_memory (id, workspace_id, user_id, url, url_key, origin, title, excerpt, retention_until) VALUES ('x', '${WS}', 'u', 'u', 'u', 'o', 't', 'e', now())`));
  });
  it("another workspace sees none of it, and cannot write a row for this one", async () => {
    await withWorkspaceScope(OTHER, async (tx) => {
      for (const t of TABLES) {
        const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM ${t}`);
        assert.equal(Number(rows[0].n), 0, t);
      }
    });
    await assert.rejects(withWorkspaceScope(OTHER, (tx) => tx.agentwebResearch.create({ data: { id: "x", workspaceId: WS, userId: "u", title: "t", question: "q" } })));
  });
});
