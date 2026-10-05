// ShapesOS — Phase 2 (F): connector intro state-machine integrity.
// Every transition is a guarded updateMany (a concurrent loser gets
// intro_conflict → 409), expiry is enforced when a proposal is acted on (not
// only by the sweep), and the boundary parser honors the phrasings the
// 2026-10-03 audit found it missed.
// Run: npx tsx --test lib/connector/__tests__/intro-integrity.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaConnectorStore } from "../prisma-store";
import { PrismaIntroductionStore } from "../introduction-store";
import { introAskWindow, type IntroActor } from "../introductions";
import { introErrorResponse } from "@/app/api/connector/intros/intro-error";
import { ConnectorError } from "../types";

const personStore = new PrismaConnectorStore(prisma);
const store = new PrismaIntroductionStore(prisma);
const workspaces: string[] = [];
const DAY = 24 * 60 * 60 * 1000;
const HUMAN_A: IntroActor = { kind: "human", identity: "dana@example.com" };
const HUMAN_B: IntroActor = { kind: "human", identity: "alex@example.com" };
const TENANT = "tico@example.com";
const SEND = {
  message: "Dana — meet Alex. Alex — meet Dana. I'll let you two take it from here!",
  sentVia: "gmail",
  sentBy: TENANT,
};

after(async () => {
  for (const id of workspaces) await prisma.workspace.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});

async function proposed(opts: { approved?: boolean; ageDays?: number } = {}) {
  const ws = await prisma.workspace.create({
    data: { name: `p2f-intro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ownerUserId: "p2f-intro" },
  });
  workspaces.push(ws.id);
  const a = await personStore.addPerson(ws.id, { name: "Dana Whitfield", consentedBy: "p2f" });
  const b = await personStore.addPerson(ws.id, { name: "Alex Rivera", consentedBy: "p2f" });
  const intro = await store.proposeIntroduction(
    ws.id,
    {
      personAId: a.id,
      personBId: b.id,
      introPath: {
        target: { kind: "person", id: b.id, name: "Alex Rivera" },
        mutual: { id: a.id, name: "Dana Whitfield" },
        hops: [],
        strength: 0.4,
        components: {},
        explanation: { text: "via Dana", facts: {} },
      },
      draftAskMessage: "Hi Dana — would you be open to a brief intro to Alex Rivera at Northwind?",
      draftOfferMessage: "Hi Alex — Dana agreed to a brief intro. Open to a 20-minute chat next week?",
    },
    { proposedBy: "connector-agent", proposerKind: "agent" },
  );
  if (opts.approved) await store.approveByTenant(ws.id, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
  if (opts.ageDays) {
    await prisma.connectorIntroduction.update({
      where: { id: intro.id },
      data: { createdAt: new Date(Date.now() - opts.ageDays * DAY) },
    });
  }
  return { ws: ws.id, id: intro.id };
}

async function events(ws: string, id: string, kind: string) {
  return prisma.connectorIntroductionEvent.count({ where: { workspaceId: ws, introductionId: id, kind: kind as never } });
}

function codeOf(r: PromiseSettledResult<unknown>): string | null {
  return r.status === "rejected" ? (r.reason as ConnectorError).code : null;
}

describe("boundary parser", () => {
  const blocked = [
    "Do not ask me for intros",
    "don’t ask for introductions", // curly apostrophe (iOS/macOS default)
    "Never ask — I only see him annually", // ban beats the cadence keyword
    "never request intros",
    "No more intros please",
    "don't ask",
    "never ask me for intros",
    "No intros, please",
  ];
  for (const b of blocked) {
    it(`blocks: ${JSON.stringify(b)}`, () => assert.deepEqual(introAskWindow(b), { blocked: true }));
  }
  it("a ban phrased as a limit is a limit", () => {
    assert.deepEqual(introAskWindow("don’t ask for intros more than monthly"), { windowDays: 31, maxAsks: 1 });
    assert.deepEqual(introAskWindow("intros at most yearly"), { windowDays: 365, maxAsks: 1 });
    assert.deepEqual(introAskWindow("no more than one intro per quarter"), { windowDays: 91, maxAsks: 1 });
  });
  it("does not over-match", () => {
    assert.deepEqual(introAskWindow("never been asked for an intro before"), { windowDays: 91, maxAsks: 1 });
    assert.deepEqual(introAskWindow("weekly check-ins are fine"), { windowDays: 7, maxAsks: 1 });
  });
});

describe("guarded transitions (concurrency)", () => {
  it("two concurrent side-A accepts: one acceptance, ONE offer to side B, the loser gets 409", async () => {
    const { ws, id } = await proposed({ approved: true });
    const results = await Promise.allSettled([
      store.acceptSideA(ws, id, HUMAN_A, { sentVia: "gmail" }),
      store.acceptSideA(ws, id, HUMAN_A, { sentVia: "gmail" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const loser = results.find((r) => r.status === "rejected")!;
    assert.ok(["intro_conflict", "invalid_transition"].includes(codeOf(loser)!));
    assert.equal(await events(ws, id, "side_a_accepted"), 1);
    assert.equal(await events(ws, id, "offer_sent_to_side_b"), 1, "side B is offered once");
  });

  it("two concurrent tenant approvals send the ask once", async () => {
    const { ws, id } = await proposed();
    await Promise.allSettled([
      store.approveByTenant(ws, id, { approvedBy: TENANT, sentVia: "gmail" }),
      store.approveByTenant(ws, id, { approvedBy: TENANT, sentVia: "gmail" }),
    ]);
    assert.equal(await events(ws, id, "ask_sent_to_side_a"), 1);
  });

  it("accept vs withdraw race: exactly one wins", async () => {
    const { ws, id } = await proposed({ approved: true });
    const results = await Promise.allSettled([
      store.acceptSideA(ws, id, HUMAN_A, { sentVia: "gmail" }),
      store.withdrawIntroduction(ws, id, { withdrawnBy: TENANT }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const row = await prisma.connectorIntroduction.findUniqueOrThrow({ where: { id } });
    assert.equal(
      row.status,
      results[0].status === "fulfilled" ? "side_a_accepted" : "withdrawn",
      "the row reflects the winner, never a blend",
    );
  });

  it("two concurrent make_intro calls send the intro once", async () => {
    const { ws, id } = await proposed({ approved: true });
    await store.acceptSideA(ws, id, HUMAN_A, { sentVia: "gmail" });
    await store.acceptSideB(ws, id, HUMAN_B);
    await Promise.allSettled([store.makeIntro(ws, id, SEND), store.makeIntro(ws, id, SEND)]);
    assert.equal(await events(ws, id, "intro_sent"), 1);
  });

  it("two concurrent followup approvals send one followup (count 1)", async () => {
    const { ws, id } = await proposed({ approved: true });
    await store.acceptSideA(ws, id, HUMAN_A, { sentVia: "gmail" });
    await store.acceptSideB(ws, id, HUMAN_B);
    await store.makeIntro(ws, id, SEND);
    await store.proposeFollowup(ws, id, { draft: "Checking in — did you two connect? ".repeat(2), to: "both" }, { proposedBy: "connector-agent" });
    await Promise.allSettled([
      store.approveFollowup(ws, id, { approvedBy: TENANT, sentVia: "gmail" }),
      store.approveFollowup(ws, id, { approvedBy: TENANT, sentVia: "gmail" }),
    ]);
    const row = await prisma.connectorIntroduction.findUniqueOrThrow({ where: { id } });
    assert.equal(row.followupCount, 1);
    assert.equal(await events(ws, id, "followup_sent"), 1);
  });

  it("the expiry sweep racing an accept never leaves an accepted-and-expired blend", async () => {
    const { ws, id } = await proposed({ approved: true });
    const [sweep, accept] = await Promise.allSettled([
      store.sweepExpiredIntroductions(ws, { now: new Date(Date.now() + 20 * DAY) }),
      store.acceptSideA(ws, id, HUMAN_A, { sentVia: "gmail" }),
    ]);
    const row = await prisma.connectorIntroduction.findUniqueOrThrow({ where: { id } });
    if (accept.status === "fulfilled") {
      assert.equal(row.status, "side_a_accepted");
      assert.equal(sweep.status === "fulfilled" && sweep.value.expired, 0);
    } else {
      assert.equal(row.status, "expired");
    }
  });

  it("conflicts map to HTTP 409", () => {
    assert.equal(introErrorResponse(new ConnectorError("intro_conflict", "x")).status, 409);
    assert.equal(introErrorResponse(new ConnectorError("intro_expired", "x")).status, 409);
  });
});

describe("expiry is enforced at action time", () => {
  it("a 60-day-old approved proposal cannot be accepted; it is flipped to expired", async () => {
    const { ws, id } = await proposed({ approved: true, ageDays: 60 });
    await assert.rejects(
      store.acceptSideA(ws, id, HUMAN_A, { sentVia: "gmail" }),
      (e: ConnectorError) => e.code === "intro_expired",
    );
    const row = await prisma.connectorIntroduction.findUniqueOrThrow({ where: { id } });
    assert.equal(row.status, "expired");
    assert.equal(await events(ws, id, "offer_sent_to_side_b"), 0);
    assert.equal(await events(ws, id, "expired"), 1);
  });

  it("an expired proposal cannot be approved by the tenant (no ask goes out)", async () => {
    const { ws, id } = await proposed({ ageDays: 15 });
    await assert.rejects(
      store.approveByTenant(ws, id, { approvedBy: TENANT, sentVia: "gmail" }),
      (e: ConnectorError) => e.code === "intro_expired",
    );
    assert.equal(await events(ws, id, "ask_sent_to_side_a"), 0);
  });

  // Phase 4a follow-up: decline/withdraw used to skip the expiry check, so a
  // lapsed proposal could end as declined/withdrawn instead of expired.
  it("an expired proposal cannot be declined by the tenant (409 intro_expired, flipped to expired)", async () => {
    const { ws, id } = await proposed({ ageDays: 15 });
    await assert.rejects(
      store.declineByTenant(ws, id, { declinedBy: TENANT, reason: "not now" }),
      (e: ConnectorError) => e.code === "intro_expired" && introErrorResponse(e).status === 409,
    );
    const row = await prisma.connectorIntroduction.findUniqueOrThrow({ where: { id } });
    assert.equal(row.status, "expired");
    assert.equal(row.declinedAt, null);
    assert.equal(await events(ws, id, "tenant_declined"), 0);
    assert.equal(await events(ws, id, "expired"), 1);
  });

  it("an expired approved proposal cannot be declined by side A", async () => {
    const { ws, id } = await proposed({ approved: true, ageDays: 60 });
    await assert.rejects(store.declineSideA(ws, id, HUMAN_A), (e: ConnectorError) => e.code === "intro_expired");
    const row = await prisma.connectorIntroduction.findUniqueOrThrow({ where: { id } });
    assert.equal(row.status, "expired");
    assert.equal(await events(ws, id, "side_a_declined"), 0);
  });

  it("an expired proposal cannot be withdrawn; it ends expired", async () => {
    const { ws, id } = await proposed({ ageDays: 15 });
    await assert.rejects(
      store.withdrawIntroduction(ws, id, { withdrawnBy: TENANT }),
      (e: ConnectorError) => e.code === "intro_expired",
    );
    const row = await prisma.connectorIntroduction.findUniqueOrThrow({ where: { id } });
    assert.equal(row.status, "expired");
    assert.equal(await events(ws, id, "withdrawn"), 0);
  });

  it("decline and withdraw inside the window (and withdraw after acceptance) still work", async () => {
    const a = await proposed({ ageDays: 13 });
    assert.equal((await store.declineByTenant(a.ws, a.id, { declinedBy: TENANT })).status, "declined");
    const b = await proposed({ approved: true, ageDays: 13 });
    assert.equal((await store.declineSideA(b.ws, b.id, HUMAN_A)).status, "declined");
    const c = await proposed({ ageDays: 13 });
    assert.equal((await store.withdrawIntroduction(c.ws, c.id, { withdrawnBy: TENANT })).status, "withdrawn");
    // Accepted states don't expire: an old accepted intro can still be withdrawn.
    const d = await proposed({ approved: true });
    await store.acceptSideA(d.ws, d.id, HUMAN_A, { sentVia: "gmail" });
    await prisma.connectorIntroduction.update({ where: { id: d.id }, data: { createdAt: new Date(Date.now() - 60 * DAY) } });
    assert.equal((await store.withdrawIntroduction(d.ws, d.id, { withdrawnBy: TENANT })).status, "withdrawn");
  });

  it("a proposal inside its window still works", async () => {
    const { ws, id } = await proposed({ approved: true, ageDays: 13 });
    const v = await store.acceptSideA(ws, id, HUMAN_A, { sentVia: "gmail" });
    assert.equal(v.status, "side_a_accepted");
  });
});
