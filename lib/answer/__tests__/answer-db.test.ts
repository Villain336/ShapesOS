// Phase 21A (WS=agentweb): the answer engine against Postgres as the app role,
// with the REAL model path (router -> a scripted fake of the OpenAI Responses
// API, MOCK) and a fake paid search provider (MOCK: no live key exists).
//   1. the answer is stored with claim citations; the cited source has a signed
//      receipt (capture) scoped to the workspace and chained into the audit log;
//   2. cost reconciles with the ledger: web_search_call + llm_tokens events;
//   3. the per-answer cap stops cleanly with an honest partial and no overspend;
//   4. a member only gets workspace-index results they could open themselves
//      (a private note of someone else's stays out), and a receipt of a workspace
//      record is readable only by the person whose answer cited it;
//   5. another workspace sees none of it; a capped workspace is refused cleanly.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/answer/__tests__/answer-db.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");
process.env.MARKETR_STORAGE ||= "local";

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { settleBackgroundWork } from "@/lib/runtime/shutdown";
import { flushUsageRecording } from "@/lib/llm/usage";
import { startFakeModel, type FakeModel } from "@/lib/chat/__tests__/fake-responses";
import { createNote } from "@/lib/notes/service";
import { saveConfig } from "@/lib/agentweb/settings";
import { listCaptures } from "@/lib/agentweb/captures-store";
import { AnswerError, getAnswer, getReceiptFor, listAnswers, runAnswer } from "../service";
import type { SearchProvider, SearchResult } from "../types";

const RUN = `p21ans-${Date.now().toString(36)}`;
const WS = `${RUN}-a`;
const OTHER = `${RUN}-b`;
const ALICE = `${RUN}-alice`;
const BOB = `${RUN}-bob`;
let model: FakeModel;

const HOURS: SearchResult = { url: "https://riverside.test/hours", title: "Opening hours", snippet: "Riverside Dental is open Monday to Friday, 9:00 to 17:00, and closed on weekends.", provider: "brave" };
const paid = (results: SearchResult[] = [HOURS]): SearchProvider => ({
  id: "brave",
  label: "Brave Search (fixture)",
  mock: false,
  estimatedCostMicroUsd: 5000,
  isConfigured: () => true,
  search: async () => ({ results, costMicroUsd: 5000 }),
});

const SYNTH = JSON.stringify({
  claims: [
    { text: "Riverside Dental is open Monday to Friday from 9:00 to 17:00.", cites: [1], evidence: ["open Monday to Friday, 9:00 to 17:00"] },
    { text: "Parking is free for patients.", cites: [1], evidence: [] },
  ],
  followUps: ["Is it open on bank holidays?"],
});
const script = (opts: { synthTokens?: { input_tokens: number; output_tokens: number } } = {}) => (body: { instructions?: string }) => {
  const sys = body.instructions ?? "";
  if (sys.includes("Classify a user's question")) return { text: '{"kind":"lookup","use":["web"],"queries":["riverside dental opening hours"],"recent":false}', usage: { input_tokens: 120, output_tokens: 40 } };
  if (sys.includes("Order the numbered")) return { text: '{"order":[1]}', usage: { input_tokens: 200, output_tokens: 10 } };
  return { text: SYNTH, usage: opts.synthTokens ?? { input_tokens: 900, output_tokens: 200 } };
};

before(async () => {
  model = await startFakeModel({ agentWorker: "off" });
  for (const id of [WS, OTHER]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: ALICE, plan: "pro" } });
});
after(async () => {
  await flushUsageRecording();
  await settleBackgroundWork();
  await model.close();
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, OTHER, `${RUN}-trial`] } } });
  await prisma.$disconnect();
});

const ask = (over: Partial<Parameters<typeof runAnswer>[0]> = {}, providers: SearchProvider[] = [paid()]) =>
  runAnswer({ workspaceId: WS, userId: ALICE, role: "editor", question: "When is Riverside Dental open?", ...over }, { providers });

describe("an answer, end to end", () => {
  it("is stored with citations; the cited source has a signed receipt, chained into the audit log", async () => {
    model.script = script();
    const out = await ask();
    assert.equal(out.status, "done");
    assert.deepEqual(out.payload.claims.map((c) => [c.status, c.reason ?? null]), [["supported", null], ["unsupported", "The cited source does not mention this."]]);
    assert.equal(out.payload.writtenBy, "model");
    assert.deepEqual(out.payload.followUps, ["Is it open on bank holidays?"]);
    const capId = out.payload.sources[0]!.captureId!;
    assert.match(capId, /^cap_/);
    const [cap] = await listCaptures(WS, { answerId: out.id });
    assert.deepEqual([cap!.id, cap!.url, cap!.signedWith, cap!.verified, cap!.provider], [capId, HOURS.url, "hmac-sha256", true, "brave"]);
    const audit = await prisma.authorityAuditEvent.findFirst({ where: { workspaceId: WS, entityId: capId } });
    assert.equal(audit?.action, "agentweb.step");
    const row = await getAnswer(WS, ALICE, out.id);
    assert.equal(row!.payload.sources[0]!.url, HOURS.url);
    assert.deepEqual((await listAnswers(WS, ALICE)).map((a) => a.id), [out.id, ...(await listAnswers(WS, ALICE)).slice(1).map((a) => a.id)]);
  });

  it("the ledger reconciles with the reported cost: web_search_call plus llm_tokens", async () => {
    model.script = script();
    const out = await ask();
    await flushUsageRecording();
    const events = await withWorkspaceScope(WS, (tx) => tx.usageEvent.findMany({ where: { workspaceId: WS, occurredAt: { gte: new Date(Date.now() - 60_000) } }, orderBy: { occurredAt: "asc" } }));
    const search = events.filter((e) => e.evidenceRef === `answer:${out.id}`);
    assert.deepEqual(search.map((e) => [e.action, e.credits]), [["web_search_call", 2]]);
    assert.equal(out.usage.providerCredits, 2);
    assert.equal(out.usage.providerMicroUsd, 5000);
    assert.ok(out.usage.modelCredits >= 2, "plan + rerank-free synth were metered");
    assert.equal(out.usage.credits, out.usage.providerCredits + out.usage.modelCredits);
    assert.ok(out.usage.credits <= out.usage.capCredits);
    assert.equal(out.usage.mock, false);
  });
});

describe("the hard per-answer credit cap", () => {
  it("stops cleanly with an honest partial: sources kept, no written answer, nothing past the cap", async () => {
    await saveConfig(WS, { answerCapCredits: 3 }, ["brave", "exa", "mock"]);
    model.script = script();
    const before = model.requests.length;
    const out = await ask();
    assert.equal(out.status, "partial");
    assert.deepEqual(out.payload.claims, []);
    assert.equal(out.payload.sources.length, 1);
    assert.match(out.payload.notes.join(" "), /credit cap for one answer \(3 credits\)/);
    assert.ok(out.usage.credits <= 3, `spent ${out.usage.credits}`);
    const synthCalls = model.requests.slice(before).filter((r) => !(r.body.instructions ?? "").includes("Classify") && !(r.body.instructions ?? "").includes("Order the"));
    assert.equal(synthCalls.length, 0, "the writing call was never made");
    assert.equal((await getAnswer(WS, ALICE, out.id))!.status, "partial");
    await saveConfig(WS, { answerCapCredits: 25 }, ["brave", "exa", "mock"]);
  });
});

describe("the workspace index, as the caller", () => {
  it("returns only what the member could open: a private note of someone else's stays out", async () => {
    const note = await createNote({ workspaceId: WS, createdBy: ALICE, title: "Boiler quote notes", body: "Customer asked about the boiler quote for the flat.", shareState: "private" });
    assert.ok(note.id);
    const q = "What did our customer say in the note about the boiler quote?";
    const bob = await runAnswer({ workspaceId: WS, userId: BOB, role: "viewer", question: q }, { providers: [paid([])], overrides: { model: null } });
    assert.deepEqual(bob.payload.sources.filter((s) => s.providers.includes("workspace")), []);
    const alice = await runAnswer({ workspaceId: WS, userId: ALICE, role: "editor", question: q }, { providers: [paid([])], overrides: { model: null } });
    const mine = alice.payload.sources.filter((s) => s.providers.includes("workspace"));
    assert.equal(mine.length, 1);
    assert.match(mine[0]!.title, /Boiler quote notes/);
    assert.equal(mine[0]!.trust, 1);
    // The receipt of a workspace record is only for the person whose answer cited it.
    const capId = mine[0]!.captureId;
    assert.ok(capId, "the note was cited, so it has a receipt");
    assert.ok(await getReceiptFor(WS, ALICE, capId));
    assert.equal(await getReceiptFor(WS, BOB, capId), null);
  });
});

describe("workspaces and caps", () => {
  it("another workspace sees no answers and no receipts", async () => {
    model.script = script();
    const out = await ask();
    assert.equal(await getAnswer(OTHER, ALICE, out.id), null);
    assert.deepEqual(await listAnswers(OTHER, ALICE), []);
    assert.equal(await getReceiptFor(OTHER, ALICE, out.payload.sources[0]!.captureId!), null);
  });

  it("only the asker reads an answer back", async () => {
    model.script = script();
    const out = await ask();
    assert.equal(await getAnswer(WS, BOB, out.id), null);
  });

  it("an ended trial is refused cleanly before anything is spent", async () => {
    const id = `${RUN}-trial`;
    await prisma.workspace.create({ data: { id, name: id, ownerUserId: ALICE, plan: "trial", trialEndsAt: new Date(Date.now() - 86_400_000) } });
    const before = model.requests.length;
    await assert.rejects(() => runAnswer({ workspaceId: id, userId: ALICE, role: "owner", question: "When is Riverside Dental open?" }, { providers: [paid()] }), (e: unknown) => e instanceof AnswerError && e.status === 402);
    assert.equal(model.requests.length, before);
  });

  it("rejects an empty or oversized question", async () => {
    await assert.rejects(() => ask({ question: "hi" }), AnswerError);
    await assert.rejects(() => ask({ question: "x".repeat(501) }), AnswerError);
  });
});
