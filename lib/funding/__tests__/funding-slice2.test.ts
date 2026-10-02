// Marketr — Funding/VC slice 2 tests: investor CRM pipeline, enrichment,
// interaction history, and follow-up reminders + alert sweep.
// Run: npx tsx --test lib/funding/__tests__/funding-slice2.test.ts
//
// DB-backed tests run against the local dev DB and clean up their own test
// workspaces. Sweep tests inject a fake store + emitter (no DB, no hub).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaFundingStore } from "../prisma-store";
import { FundingError, isLegalStageTransition } from "../types";
import {
  sweepFundingFollowUpAlerts,
  tierForFollowUp,
  type FollowUpSweepStore,
} from "../followup-sweep";

const store = new PrismaFundingStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-funding-slice2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-funding-slice2",
    },
  });
  testWorkspaceIds.push(ws.id);
  return ws.id;
}

after(async () => {
  await prisma.workspace.deleteMany({
    where: { id: { in: testWorkspaceIds } },
  });
  await prisma.$disconnect();
});

describe("stage transitions", () => {
  it("allows the full forward pipeline: target → contacted → meeting → diligence → term_sheet → won", async () => {
    const ws = await makeWorkspace();
    const inv = await store.createInvestor(ws, { name: "Pipeline VC" });
    assert.equal(inv.stage, "target");

    const order = ["contacted", "meeting", "diligence", "term_sheet", "won"] as const;
    for (const stage of order) {
      const updated = await store.transitionStage(ws, inv.id, stage, "founder@example.com");
      assert.equal(updated.stage, stage);
    }

    // Every transition recorded lineage: a stage_change interaction with the actor.
    const rows = await prisma.fundingInteraction.findMany({
      where: { workspaceId: ws, investorId: inv.id, kind: "stage_change" },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(rows.length, 5);
    assert.equal(rows[0].summary, "Stage: target → contacted");
    assert.equal(rows[0].actor, "founder@example.com");
    assert.ok(rows[0].occurredAt instanceof Date);
  });

  it("rejects illegal moves (skipping stages, moving off terminal won)", async () => {
    const ws = await makeWorkspace();
    const inv = await store.createInvestor(ws, { name: "Strict VC" });

    await assert.rejects(
      () => store.transitionStage(ws, inv.id, "meeting", "founder"),
      (e) => e instanceof FundingError && e.code === "illegal_stage_transition",
    );
    await assert.rejects(
      () => store.transitionStage(ws, inv.id, "won", "founder"),
      (e) => e instanceof FundingError && e.code === "illegal_stage_transition",
    );
    // Illegal moves record nothing.
    const count = await prisma.fundingInteraction.count({
      where: { workspaceId: ws, investorId: inv.id },
    });
    assert.equal(count, 0);
    const fresh = await store.listInvestors(ws);
    assert.equal(fresh[0].stage, "target");

    // won is terminal: no legal moves out.
    await store.transitionStage(ws, inv.id, "contacted", "founder");
    await store.transitionStage(ws, inv.id, "meeting", "founder");
    await store.transitionStage(ws, inv.id, "diligence", "founder");
    await store.transitionStage(ws, inv.id, "term_sheet", "founder");
    await store.transitionStage(ws, inv.id, "won", "founder");
    await assert.rejects(
      () => store.transitionStage(ws, inv.id, "contacted", "founder"),
      (e) => e instanceof FundingError && e.code === "illegal_stage_transition",
    );
  });

  it("allows one-step backward moves and re-opening from lost/passed", async () => {
    const ws = await makeWorkspace();
    const inv = await store.createInvestor(ws, { name: "Backtrack VC" });

    await store.transitionStage(ws, inv.id, "contacted", "founder");
    await store.transitionStage(ws, inv.id, "target", "founder"); // backward
    let cur = await store.getInvestorDetail(ws, inv.id);
    assert.equal(cur.investor.stage, "target");

    // Any active stage can resolve to an outcome.
    await store.transitionStage(ws, inv.id, "passed", "founder");
    // Outcomes re-open at target.
    await store.transitionStage(ws, inv.id, "target", "founder");
    cur = await store.getInvestorDetail(ws, inv.id);
    assert.equal(cur.investor.stage, "target");

    await store.transitionStage(ws, inv.id, "contacted", "founder");
    await store.transitionStage(ws, inv.id, "lost", "founder");
    const rows = await prisma.fundingInteraction.findMany({
      where: { workspaceId: ws, investorId: inv.id, kind: "stage_change" },
    });
    assert.equal(rows.length, 6);
  });

  it("isLegalStageTransition matches the documented graph", () => {
    assert.ok(isLegalStageTransition("target", "contacted"));
    assert.ok(isLegalStageTransition("diligence", "meeting"));
    assert.ok(!isLegalStageTransition("target", "meeting"));
    assert.ok(!isLegalStageTransition("won", "lost"));
    assert.ok(!isLegalStageTransition("target", "target"));
    assert.ok(isLegalStageTransition("passed", "target"));
  });
});

describe("tenant scoping", () => {
  it("never touches another workspace's investors, interactions, or follow-ups", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const inv = await store.createInvestor(wsA, { name: "Other tenant's investor" });

    await assert.rejects(
      () => store.transitionStage(wsB, inv.id, "contacted", "founder"),
      (e) => e instanceof FundingError && e.code === "investor_not_found",
    );
    await assert.rejects(
      () => store.logInteraction(wsB, inv.id, { kind: "call", summary: "sneaky" }),
      (e) => e instanceof FundingError && e.code === "investor_not_found",
    );
    await assert.rejects(
      () => store.updateInvestorEnrichment(wsB, inv.id, { firm: "x" }),
      (e) => e instanceof FundingError && e.code === "investor_not_found",
    );
    await assert.rejects(
      () => store.createFollowUp(wsB, inv.id, { dueAt: new Date().toISOString(), note: "sneaky" }),
      (e) => e instanceof FundingError && e.code === "investor_not_found",
    );
    await assert.rejects(
      () => store.getInvestorDetail(wsB, inv.id),
      (e) => e instanceof FundingError && e.code === "investor_not_found",
    );
  });
});

describe("enrichment", () => {
  it("saves self-reported enrichment and marks enriched provenance", async () => {
    const ws = await makeWorkspace();
    const inv = await store.createInvestor(ws, { name: "Enrich VC" });

    const self = await store.updateInvestorEnrichment(ws, inv.id, {
      firm: "Enrich Capital",
      title: "Partner",
      email: "partner@enrich.vc",
      checkSizeMin: 50_000,
      checkSizeMax: 500_000,
      sectors: ["fintech"],
      thesisFit: "Fintech infra at pre-seed.",
      enrichmentSource: "self_reported",
    });
    assert.equal(self.enrichmentSource, "self_reported");
    assert.equal(self.firm, "Enrich Capital");
    assert.equal(self.title, "Partner");

    // enriched requires fetchedAt.
    await assert.rejects(
      () => store.updateInvestorEnrichment(ws, inv.id, { enrichmentSource: "enriched" }),
      (e) => e instanceof FundingError && e.code === "invalid_enrichment",
    );
    const enriched = await store.updateInvestorEnrichment(ws, inv.id, {
      enrichmentSource: "enriched",
      enrichmentFetchedAt: "2026-09-30T00:00:00.000Z",
      enrichmentNotes: "Fetched via provider.",
    });
    assert.equal(enriched.enrichmentSource, "enriched");
    assert.ok(enriched.enrichmentFetchedAt instanceof Date);
  });

  it("validates email and check-size band", async () => {
    const ws = await makeWorkspace();
    const inv = await store.createInvestor(ws, { name: "Valid VC" });
    await assert.rejects(
      () => store.updateInvestorEnrichment(ws, inv.id, { email: "not-an-email" }),
      (e) => e instanceof FundingError && e.code === "invalid_enrichment",
    );
    await assert.rejects(
      () =>
        store.updateInvestorEnrichment(ws, inv.id, {
          checkSizeMin: 1_000_000,
          checkSizeMax: 100_000,
        }),
      (e) => e instanceof FundingError && e.code === "invalid_enrichment",
    );
  });
});

describe("interaction history", () => {
  it("logs typed interactions with lineage and rejects stage_change", async () => {
    const ws = await makeWorkspace();
    const inv = await store.createInvestor(ws, { name: "History VC" });
    const contact = await prisma.fundingContact.create({
      data: { workspaceId: ws, name: "Helper", source: "founder_added" },
    });

    const logged = await store.logInteraction(
      ws,
      inv.id,
      { kind: "call", summary: "Great first call, sending deck.", contactId: contact.id },
      "founder@example.com",
    );
    assert.equal(logged.kind, "call");
    assert.equal(logged.actor, "founder@example.com");
    assert.equal(logged.contactName, "Helper");

    // stage_change is written by transitions only.
    await assert.rejects(
      () => store.logInteraction(ws, inv.id, { kind: "stage_change" as never, summary: "manual" }),
      (e) => e instanceof FundingError && e.code === "invalid_interaction",
    );

    await assert.rejects(
      () => store.logInteraction(ws, inv.id, { kind: "call", summary: "   " }),
      (e) => e instanceof FundingError && e.code === "invalid_interaction",
    );

    const { interactions } = await store.getInvestorDetail(ws, inv.id);
    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].summary, "Great first call, sending deck.");
  });
});

describe("follow-ups", () => {
  it("creates, surfaces, and completes follow-ups", async () => {
    const ws = await makeWorkspace();
    const inv = await store.createInvestor(ws, { name: "Followup VC" });
    const dueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const created = await store.createFollowUp(ws, inv.id, {
      dueAt: dueAt.toISOString(),
      note: "Send the data room link.",
    });
    assert.equal(created.done, false);
    assert.equal(created.investorName, "Followup VC");

    await assert.rejects(
      () => store.createFollowUp(ws, inv.id, { dueAt: "garbage", note: "x" }),
      (e) => e instanceof FundingError && e.code === "invalid_followup",
    );

    const open = await store.listOpenFollowUps(ws);
    assert.equal(open.length, 1);
    assert.equal(open[0].id, created.id);
    assert.equal(open[0].lastAlertedTier, null);

    const pipeline = await store.listPipelineInvestors(ws);
    assert.equal(pipeline[0].openFollowUps.length, 1);

    const done = await store.completeFollowUp(ws, created.id);
    assert.equal(done.done, true);
    assert.ok(done.doneAt instanceof Date);
    const openAfter = await store.listOpenFollowUps(ws);
    assert.equal(openAfter.length, 0);
  });

  it("rejects completing another workspace's follow-up", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const inv = await store.createInvestor(wsA, { name: "Scoped VC" });
    const f = await store.createFollowUp(wsA, inv.id, {
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      note: "Nudge.",
    });
    await assert.rejects(
      () => store.completeFollowUp(wsB, f.id),
      (e) => e instanceof FundingError && e.code === "followup_not_found",
    );
  });
});

describe("follow-up sweep tiers", () => {
  it("computes upcoming / due_today / overdue and ignores far-future dates", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    assert.equal(tierForFollowUp(new Date("2026-10-03T00:00:00Z"), now), "upcoming");
    assert.equal(tierForFollowUp(new Date("2026-10-01T23:59:59Z"), now), "due_today");
    assert.equal(tierForFollowUp(new Date("2026-09-30T00:00:00Z"), now), "overdue");
    assert.equal(tierForFollowUp(new Date("2026-11-15T00:00:00Z"), now), null);
  });

  it("emits once per tier, escalates on tier change, dedups same tier", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const emitted: unknown[] = [];
    const recorded: { id: string; tier: string }[] = [];
    const fakeStore: FollowUpSweepStore = {
      listOpenFollowUps: async () => [
        {
          id: "f-upcoming",
          investorId: "i1",
          investorName: "Soon VC",
          dueAt: new Date("2026-10-04T00:00:00Z"),
          note: "Send metrics.",
          lastAlertedTier: null,
        },
        {
          id: "f-due",
          investorId: "i2",
          investorName: "Today VC",
          dueAt: new Date("2026-10-01T15:00:00Z"),
          note: "Call back.",
          lastAlertedTier: "upcoming", // escalating: upcoming → due_today
        },
        {
          id: "f-late",
          investorId: "i3",
          investorName: "Late VC",
          dueAt: new Date("2026-09-20T00:00:00Z"),
          note: "Resend deck.",
          lastAlertedTier: "overdue", // already alerted — skip
        },
        {
          id: "f-far",
          investorId: "i4",
          investorName: "Far VC",
          dueAt: new Date("2026-12-01T00:00:00Z"),
          note: "Holiday check-in.",
          lastAlertedTier: null, // too far out — skip
        },
      ],
      recordFollowUpAlertedTier: async (_ws, id, tier) => {
        recorded.push({ id, tier });
      },
    };

    const result = await sweepFundingFollowUpAlerts(
      fakeStore,
      async (input) => {
        emitted.push(input);
      },
      "ws-test",
      { now },
    );

    assert.equal(result.checked, 4);
    assert.equal(result.emitted, 2);
    assert.equal(result.skipped, 2);
    assert.deepEqual(
      result.fired.map((f) => f.tier).sort(),
      ["due_today", "upcoming"],
    );
    assert.deepEqual(recorded, [
      { id: "f-upcoming", tier: "upcoming" },
      { id: "f-due", tier: "due_today" },
    ]);

    const inputs = emitted as {
      trigger: string;
      severity: string;
      title: string;
      dedupKey: string;
    }[];
    assert.equal(inputs[0].trigger, "funding_followup");
    assert.equal(inputs[0].dedupKey, "funding_followup:f-upcoming:upcoming");
    // Severity ladders with the tier: info → warn.
    assert.deepEqual(inputs.map((i) => i.severity), ["info", "warn"]);
    assert.ok(inputs[0].title.includes("Soon VC"));
  });

  it("emits the overdue tier at critical severity with a grounded date", async () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const emitted: unknown[] = [];
    const fakeStore: FollowUpSweepStore = {
      listOpenFollowUps: async () => [
        {
          id: "f-x",
          investorId: "i9",
          investorName: "Overdue VC",
          dueAt: new Date("2026-09-15T00:00:00Z"),
          note: "Follow up on term sheet.",
          lastAlertedTier: null,
        },
      ],
      recordFollowUpAlertedTier: async () => {},
    };
    await sweepFundingFollowUpAlerts(
      fakeStore,
      async (input) => {
        emitted.push(input);
      },
      "ws-test",
      { now },
    );
    const input = emitted[0] as { severity: string; body: string; dedupKey: string };
    assert.equal(input.severity, "critical");
    assert.equal(input.dedupKey, "funding_followup:f-x:overdue");
    assert.ok(input.body.includes("Overdue VC"));
    assert.ok(input.body.includes("Sep 15, 2026"));
  });
});
