// Marketr — Connector Agent slice 4 tests: double-opt-in lifecycle.
// Run: npx tsx --test lib/connector/__tests__/connector-slice4.test.ts
//
// Pure domain tests pin the transition law, the human-only actor rule,
// rate-limit windows, and expiry math. DB-backed tests run against the
// local dev DB and clean up their own test workspaces (cascades purge
// connector rows).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaConnectorStore } from "../prisma-store";
import { PrismaIntroductionStore } from "../introduction-store";
import { ConnectorError } from "../types";
import {
  assertIntroTransition,
  assertIntroPreconditions,
  CONNECTOR_INTRO_EVENTS,
  CONNECTOR_INTRO_STATUSES,
  CONNECTOR_INTRO_TRANSITIONS,
  introAskWindow,
  isIntroExpired,
  requireHumanActor,
  validateFollowupInput,
  validateIntroSendInput,
  validateProposeIntroductionInput,
  type ConnectorIntroEvent,
  type ConnectorIntroductionStatus,
  type IntroActor,
} from "../introductions";

const personStore = new PrismaConnectorStore(prisma);
const store = new PrismaIntroductionStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-connector-slice4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-connector-slice4",
    },
  });
  testWorkspaceIds.push(ws.id);
  return ws.id;
}

after(async () => {
  for (const id of testWorkspaceIds) {
    await prisma.workspace.delete({ where: { id } }).catch(() => {});
  }
});

const NOW = new Date("2026-10-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

async function addPerson(
  ws: string,
  name: string,
  opts: { boundaries?: string } = {},
): Promise<string> {
  const p = await personStore.addPerson(ws, { name, consentedBy: "slice4-test" });
  if (opts.boundaries) {
    await personStore.recordTouch(ws, { personId: p.id, direction: "outbound" });
    await personStore.updateRelationship(ws, p.id, { boundaries: opts.boundaries });
  }
  return p.id;
}

/** Minimal computed-IntroPath snapshot linking mutual → target. */
function pathSnapshot(mutualId: string, mutualName: string, targetId: string, targetName: string) {
  return {
    target: { kind: "person", id: targetId, name: targetName },
    mutual: { id: mutualId, name: mutualName },
    hops: [
      { kind: "tenant", id: null, name: "Tenant" },
      { kind: "person", id: mutualId, name: mutualName },
      { kind: "person", id: targetId, name: targetName },
    ],
    strength: 0.42,
    components: { tenantWarmth: 70, linkStrength: 0.8, freshness: 0.75 },
    explanation: {
      text: `via ${mutualName} — worked together at Acme (2022–24), last touched 3 weeks ago`,
      facts: {
        mutualName,
        sharedCompany: "Acme",
        overlapStart: 2022,
        overlapEnd: 2024,
        lastTouchText: "3 weeks ago",
        notes: null,
      },
    },
  };
}

async function proposePair(
  ws: string,
  mutualId: string,
  targetId: string,
  mutualName = "Mutual",
  targetName = "Target",
  extra: Record<string, unknown> = {},
) {
  return store.proposeIntroduction(
    ws,
    {
      personAId: mutualId,
      personBId: targetId,
      introPath: pathSnapshot(mutualId, mutualName, targetId, targetName),
      draftAskMessage:
        "Hi Dana — would you be open to a brief intro to Alex Rivera at Northwind? They're raising a seed round and I thought of you immediately. No worries at all if the timing is off.",
      draftOfferMessage:
        "Hi Alex — Dana Whitfield (ex-Acme, now at Northwind) agreed to a brief intro. She's happy to share what worked in their seed raise. Open to a 20-minute chat next week?",
      ...extra,
    },
    { proposedBy: "connector-agent", proposerKind: "agent", now: NOW },
  );
}

const HUMAN_A: IntroActor = { kind: "human", identity: "dana@example.com" };
const HUMAN_B: IntroActor = { kind: "human", identity: "alex@example.com" };
const TENANT = "tico@example.com";
const AGENT: IntroActor = { kind: "agent", identity: "connector-agent" };

async function happyPathToAccepted(ws: string) {
  const a = await addPerson(ws, "Dana Whitfield");
  const b = await addPerson(ws, "Alex Rivera");
  let intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
  intro = await store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
  intro = await store.acceptSideA(ws, intro.id, HUMAN_A, { sentVia: "gmail" });
  intro = await store.acceptSideB(ws, intro.id, HUMAN_B);
  return { a, b, intro };
}

async function assertThrowsCode(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof ConnectorError, `expected ConnectorError, got ${e}`);
    assert.equal((e as ConnectorError).code, code);
    return;
  }
  assert.fail(`expected ConnectorError(${code}) but nothing was thrown`);
}

// ---------------------------------------------------------------------------
// Pure domain: the transition law — every illegal transition rejected.
// ---------------------------------------------------------------------------

describe("slice 4 — transition law (exhaustive)", () => {
  it("accepts exactly the table's transitions, rejects everything else", () => {
    let legal = 0;
    let illegal = 0;
    for (const from of CONNECTOR_INTRO_STATUSES) {
      const allowed = new Set<ConnectorIntroEvent>(CONNECTOR_INTRO_TRANSITIONS[from]);
      for (const event of CONNECTOR_INTRO_EVENTS) {
        if (allowed.has(event)) {
          assert.doesNotThrow(() => assertIntroTransition(from, event));
          legal++;
        } else {
          assert.throws(
            () => assertIntroTransition(from as ConnectorIntroductionStatus, event),
            (e: unknown) => e instanceof ConnectorError && e.code === "invalid_transition",
            `expected invalid_transition for ${event} from ${from}`,
          );
          illegal++;
        }
      }
    }
    // 8 statuses × 11 events; the table defines 6+3+2+2+2 = 15 legal.
    assert.equal(legal, 15);
    assert.equal(illegal, 8 * 11 - 15);
  });

  it("terminal states have no legal events", () => {
    for (const s of ["declined", "expired", "withdrawn"] as const) {
      assert.deepEqual(CONNECTOR_INTRO_TRANSITIONS[s], []);
    }
  });

  it("make is legal only from side_b_accepted", () => {
    for (const s of CONNECTOR_INTRO_STATUSES) {
      if (s === "side_b_accepted") {
        assert.doesNotThrow(() => assertIntroTransition(s, "make"));
      } else {
        assert.throws(
          () => assertIntroTransition(s, "make"),
          (e: unknown) => e instanceof ConnectorError && e.code === "invalid_transition",
          `expected invalid_transition for make from ${s}`,
        );
      }
    }
  });

  it("expire is legal only from proposed", () => {
    for (const s of CONNECTOR_INTRO_STATUSES) {
      if (s === "proposed") {
        assert.doesNotThrow(() => assertIntroTransition(s, "expire"));
      } else {
        assert.throws(
          () => assertIntroTransition(s, "expire"),
          (e: unknown) => e instanceof ConnectorError && e.code === "invalid_transition",
          `expected invalid_transition for expire from ${s}`,
        );
      }
    }
  });

  it("side A needs tenant approval before acting", () => {
    assert.throws(
      () =>
        assertIntroPreconditions({
          event: "side_a_accept",
          tenantApproved: false,
          pendingFollowupDraft: false,
        }),
      (e: unknown) => e instanceof ConnectorError && e.code === "tenant_approval_required",
    );
    assert.doesNotThrow(() =>
      assertIntroPreconditions({
        event: "side_a_accept",
        tenantApproved: true,
        pendingFollowupDraft: false,
      }),
    );
  });

  it("followup_approve needs a pending draft; propose rejects a second pending", () => {
    assert.throws(
      () =>
        assertIntroPreconditions({
          event: "followup_approve",
          tenantApproved: true,
          pendingFollowupDraft: false,
        }),
      (e: unknown) => e instanceof ConnectorError && e.code === "no_followup_pending",
    );
    assert.throws(
      () =>
        assertIntroPreconditions({
          event: "followup_propose",
          tenantApproved: true,
          pendingFollowupDraft: true,
        }),
      (e: unknown) => e instanceof ConnectorError && e.code === "followup_pending",
    );
  });
});

describe("slice 4 — human-only actors", () => {
  it("rejects agent actors (including the tenant's own agent)", () => {
    assert.throws(
      () => requireHumanActor({ kind: "agent", identity: "connector-agent" }, "side_a_accept"),
      (e: unknown) => e instanceof ConnectorError && e.code === "agent_cannot_act",
    );
    assert.throws(
      () => requireHumanActor({ kind: "agent" }, "side_b_accept"),
      (e: unknown) => e instanceof ConnectorError && e.code === "agent_cannot_act",
    );
  });

  it("rejects empty human identities", () => {
    assert.throws(
      () => requireHumanActor({ kind: "human", identity: "   " }, "make_intro"),
      (e: unknown) => e instanceof ConnectorError && e.code === "invalid_actor",
    );
  });

  it("accepts a real human identity and trims it", () => {
    assert.equal(requireHumanActor({ kind: "human", identity: "  dana@example.com " }, "x"), "dana@example.com");
  });
});

describe("slice 4 — rate-limit windows from boundaries", () => {
  it("defaults to one ask per 91 days", () => {
    assert.deepEqual(introAskWindow(null), { windowDays: 91, maxAsks: 1 });
    assert.deepEqual(introAskWindow(""), { windowDays: 91, maxAsks: 1 });
    assert.deepEqual(introAskWindow("met at Raleigh Founded"), { windowDays: 91, maxAsks: 1 });
  });

  it("parses never/monthly/quarterly/yearly/weekly", () => {
    assert.deepEqual(introAskWindow("never ask me for intros"), { blocked: true });
    assert.deepEqual(introAskWindow("No intros, please"), { blocked: true });
    assert.deepEqual(introAskWindow("don't ask for intros more than monthly"), { windowDays: 31, maxAsks: 1 });
    assert.deepEqual(introAskWindow("don't ask for intros more than quarterly"), { windowDays: 91, maxAsks: 1 });
    assert.deepEqual(introAskWindow("intros at most yearly"), { windowDays: 365, maxAsks: 1 });
    assert.deepEqual(introAskWindow("weekly check-ins are fine"), { windowDays: 7, maxAsks: 1 });
  });
});

describe("slice 4 — expiry math", () => {
  it("expires at the window boundary", () => {
    const proposedAt = new Date(NOW.getTime() - 14 * DAY);
    assert.equal(isIntroExpired(proposedAt, NOW, 14), true);
    assert.equal(isIntroExpired(new Date(NOW.getTime() - 13 * DAY), NOW, 14), false);
    assert.equal(isIntroExpired(proposedAt, NOW, 30), false);
  });

  it("non-positive windows never expire", () => {
    assert.equal(isIntroExpired(new Date(0), NOW, 0), false);
  });
});

describe("slice 4 — input validation", () => {
  it("rejects same-person pairs and short drafts", () => {
    const base = {
      personAId: "a",
      personBId: "a",
      introPath: pathSnapshot("a", "A", "b", "B"),
      draftAskMessage: "x".repeat(30),
      draftOfferMessage: "y".repeat(30),
    };
    assert.ok(validateProposeIntroductionInput(base).errors.length > 0);
    const short = { ...base, personBId: "b", draftAskMessage: "too short" };
    const r = validateProposeIntroductionInput(short);
    assert.ok(!r.value && r.errors.some((e) => e.includes("draftAskMessage")));
  });

  it("requires a real IntroPath snapshot with a mutual", () => {
    const r = validateProposeIntroductionInput({
      personAId: "a",
      personBId: "b",
      introPath: { notAPath: true },
      draftAskMessage: "x".repeat(30),
      draftOfferMessage: "y".repeat(30),
    });
    assert.ok(!r.value);
  });

  it("bounds the rate-limit override", () => {
    const good = validateProposeIntroductionInput({
      personAId: "a",
      personBId: "b",
      introPath: pathSnapshot("a", "A", "b", "B"),
      draftAskMessage: "x".repeat(30),
      draftOfferMessage: "y".repeat(30),
      rateLimitOverride: { maxAsks: 3, windowDays: 30 },
    });
    assert.ok(good.value);
    const bad = validateProposeIntroductionInput({
      personAId: "a",
      personBId: "b",
      introPath: pathSnapshot("a", "A", "b", "B"),
      draftAskMessage: "x".repeat(30),
      draftOfferMessage: "y".repeat(30),
      rateLimitOverride: { maxAsks: 99, windowDays: 30 },
    });
    assert.ok(!bad.value);
  });

  it("validates followup and send inputs", () => {
    assert.ok(!validateFollowupInput({ draft: "short", to: "both" }).value);
    assert.ok(!validateFollowupInput({ draft: "x".repeat(25), to: "sideways" }).value);
    assert.ok(validateFollowupInput({ draft: "x".repeat(25), to: "side_b" }).value);
    assert.ok(!validateIntroSendInput({ message: "x".repeat(25) }).value); // no sentVia
    assert.ok(validateIntroSendInput({ message: "x".repeat(25), sentVia: "gmail" }).value);
  });
});

// ---------------------------------------------------------------------------
// DB: propose + inbox + tenant isolation.
// ---------------------------------------------------------------------------

describe("slice 4 — propose + approval inbox", () => {
  it("proposes into the inbox with the path snapshot and draft copy", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");

    assert.equal(intro.status, "proposed");
    assert.equal(intro.tenantApproved, false);
    assert.equal(intro.personA.id, a);
    assert.equal(intro.personB.id, b);
    assert.match(intro.draftAskMessage, /Dana/);
    const snap = intro.introPathSnapshot as { mutual: { id: string }; explanation: { text: string } };
    assert.equal(snap.mutual.id, a);
    assert.match(snap.explanation.text, /Dana/);

    const inbox = await store.listIntroductions(ws, { awaitingApproval: true });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].id, intro.id);

    const detail = await store.getIntroductionDetail(ws, intro.id);
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0].kind, "proposed");
    assert.equal(detail.events[0].actorKind, "agent");
    assert.equal(detail.events[0].actorIdentity, "connector-agent");
  });

  it("rejects a path snapshot that does not link these two people", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    await assertThrowsCode(
      () =>
        store.proposeIntroduction(
          ws,
          {
            personAId: a,
            personBId: b,
            introPath: pathSnapshot("someone-else", "Zed", b, "Alex Rivera"),
            draftAskMessage: "x".repeat(30),
            draftOfferMessage: "y".repeat(30),
          },
          { proposedBy: "connector-agent", proposerKind: "agent" },
        ),
      "intro_path_mismatch",
    );
  });

  it("tenant isolation: another workspace cannot read or act", async () => {
    const ws = await makeWorkspace();
    const other = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");

    await assertThrowsCode(() => store.getIntroductionDetail(other, intro.id), "introduction_not_found");
    await assertThrowsCode(
      () => store.acceptSideA(other, intro.id, HUMAN_A, { sentVia: "gmail" }),
      "introduction_not_found",
    );
    assert.equal((await store.listIntroductions(other, { awaitingApproval: true })).length, 0);
  });
});

describe("slice 4 — tenant approval gate", () => {
  it("approval records the ask send; double approval rejected", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");

    const approved = await store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    assert.equal(approved.status, "proposed"); // still proposed — side A hasn't acted
    assert.equal(approved.tenantApproved, true);
    assert.equal(approved.tenantApprovedBy, TENANT);

    const detail = await store.getIntroductionDetail(ws, intro.id);
    const kinds = detail.events.map((e) => e.kind);
    assert.deepEqual(kinds, ["proposed", "tenant_approved", "ask_sent_to_side_a"]);
    const ask = detail.events[2];
    assert.equal(ask.actorKind, "tenant");
    assert.match(ask.message ?? "", /Dana/); // the exact draft copy is on the event

    await assertThrowsCode(
      () => store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" }),
      "already_approved",
    );
    // Approval removes it from the inbox.
    assert.equal((await store.listIntroductions(ws, { awaitingApproval: true })).length, 0);
  });

  it("tenant decline before approval kills the proposal; not after", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");

    const declined = await store.declineByTenant(ws, intro.id, {
      declinedBy: TENANT,
      reason: "Wrong timing.",
    });
    assert.equal(declined.status, "declined");
    assert.equal(declined.declineReason, "Wrong timing.");
    const detail = await store.getIntroductionDetail(ws, intro.id);
    assert.equal(detail.events[detail.events.length - 1].kind, "tenant_declined");

    // After approval the ask is out — decline is no longer the verb.
    const a2 = await addPerson(ws, "Priya Nair");
    const b2 = await addPerson(ws, "Sam Ortiz");
    const intro2 = await proposePair(ws, a2, b2, "Priya Nair", "Sam Ortiz");
    await store.approveByTenant(ws, intro2.id, { approvedBy: TENANT, sentVia: "gmail" });
    await assertThrowsCode(
      () => store.declineByTenant(ws, intro2.id, { declinedBy: TENANT }),
      "decline_after_approval",
    );
  });
});

describe("slice 4 — human-only accept/decline on both sides", () => {
  it("side A cannot act before tenant approval", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    await assertThrowsCode(
      () => store.acceptSideA(ws, intro.id, HUMAN_A, { sentVia: "gmail" }),
      "tenant_approval_required",
    );
    await assertThrowsCode(() => store.declineSideA(ws, intro.id, HUMAN_A), "tenant_approval_required");
  });

  it("the agent cannot accept on anyone's behalf — side A, side B, or tenant", async () => {
    // Build an intro at side_a_accepted (side B may act, but only a human).
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    await store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    await store.acceptSideA(ws, intro.id, HUMAN_A, { sentVia: "gmail" });
    await assertThrowsCode(() => store.acceptSideB(ws, intro.id, AGENT), "agent_cannot_act");
    // The tenant's own agent cannot accept for side A either.
    const ws2 = await makeWorkspace();
    const a2 = await addPerson(ws2, "Dana Whitfield");
    const b2 = await addPerson(ws2, "Alex Rivera");
    const i2 = await proposePair(ws2, a2, b2, "Dana Whitfield", "Alex Rivera");
    await store.approveByTenant(ws2, i2.id, { approvedBy: TENANT, sentVia: "gmail" });
    await assertThrowsCode(
      () => store.acceptSideA(ws2, i2.id, { kind: "agent", identity: "tenant-agent" }, { sentVia: "gmail" }),
      "agent_cannot_act",
    );
    // The agent cannot decline for side B either (on an intro where side B
    // may still act — side_a_accepted).
    const ws3 = await makeWorkspace();
    const a3 = await addPerson(ws3, "Dana Whitfield");
    const b3 = await addPerson(ws3, "Alex Rivera");
    const i3 = await proposePair(ws3, a3, b3, "Dana Whitfield", "Alex Rivera");
    await store.approveByTenant(ws3, i3.id, { approvedBy: TENANT, sentVia: "gmail" });
    await store.acceptSideA(ws3, i3.id, HUMAN_A, { sentVia: "gmail" });
    await assertThrowsCode(
      () => store.declineSideB(ws3, i3.id, { kind: "agent" }),
      "agent_cannot_act",
    );
  });

  it("side B cannot act before side A accepts", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    await store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    await assertThrowsCode(() => store.acceptSideB(ws, intro.id, HUMAN_B), "invalid_transition");
    await assertThrowsCode(() => store.declineSideB(ws, intro.id, HUMAN_B), "invalid_transition");
  });

  it("side A decline records lineage and ends the intro", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    await store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    const declined = await store.declineSideA(ws, intro.id, HUMAN_A, { note: "Too busy this quarter." });
    assert.equal(declined.status, "declined");
    assert.equal(declined.declinedBy, "dana@example.com");
    const detail = await store.getIntroductionDetail(ws, intro.id);
    const kinds = detail.events.map((e) => e.kind);
    assert.deepEqual(kinds, [
      "proposed",
      "tenant_approved",
      "ask_sent_to_side_a",
      "side_a_declined",
    ]);
  });
});

describe("slice 4 — the money test: nothing sends before dual acceptance", () => {
  it("make_intro is rejected at every earlier state", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    const send = {
      message: "Dana — meet Alex. Alex — meet Dana. I'll let you two take it from here!".repeat(2),
      sentVia: "gmail",
      sentBy: TENANT,
    };

    // proposed, tenant hasn't approved
    await assertThrowsCode(() => store.makeIntro(ws, intro.id, send), "invalid_transition");
    // proposed, tenant approved, ask out to side A
    await store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    await assertThrowsCode(() => store.makeIntro(ws, intro.id, send), "invalid_transition");
    // side A accepted, offer out to side B
    await store.acceptSideA(ws, intro.id, HUMAN_A, { sentVia: "gmail" });
    await assertThrowsCode(() => store.makeIntro(ws, intro.id, send), "invalid_transition");

    // No intro_sent event exists yet — nothing went out.
    const before = await store.getIntroductionDetail(ws, intro.id);
    assert.ok(!before.events.some((e) => e.kind === "intro_sent"));

    // side B accepts → NOW make works.
    await store.acceptSideB(ws, intro.id, HUMAN_B);
    const made = await store.makeIntro(ws, intro.id, send);
    assert.equal(made.status, "made");
    assert.equal(made.madeSentBy, TENANT);
    assert.equal(made.madeSentVia, "gmail");
    assert.match(made.madeMessage ?? "", /Dana — meet Alex/);

    const after = await store.getIntroductionDetail(ws, intro.id);
    const introSends = after.events.filter((e) => e.kind === "intro_sent");
    assert.equal(introSends.length, 1);
    assert.match(introSends[0].message ?? "", /Dana — meet Alex/);

    // made is not repeatable.
    await assertThrowsCode(() => store.makeIntro(ws, intro.id, send), "invalid_transition");
  });

  it("make_intro requires a send channel and a real message", async () => {
    const ws = await makeWorkspace();
    const { intro } = await happyPathToAccepted(ws);
    await assertThrowsCode(
      () => store.makeIntro(ws, intro.id, { message: "x".repeat(60), sentVia: "  ", sentBy: TENANT }),
      "invalid_send",
    );
    await assertThrowsCode(
      () => store.makeIntro(ws, intro.id, { message: "short", sentVia: "gmail", sentBy: TENANT }),
      "invalid_send",
    );
  });
});

describe("slice 4 — rate limits per mutual", () => {
  it("blocks a second ask to the same mutual inside the window", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const c = await addPerson(ws, "Priya Nair");
    await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    // Same mutual (side A), different target — still one ask per quarter.
    await assertThrowsCode(
      () => proposePair(ws, a, c, "Dana Whitfield", "Priya Nair"),
      "intro_rate_limited",
    );
    // A different mutual is unaffected.
    const d = await addPerson(ws, "Sam Ortiz");
    const ok = await proposePair(ws, d, c, "Sam Ortiz", "Priya Nair");
    assert.equal(ok.status, "proposed");
  });

  it("tenant per-instance override is honored and recorded", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const c = await addPerson(ws, "Priya Nair");
    await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    const second = await proposePair(ws, a, c, "Dana Whitfield", "Priya Nair", {
      rateLimitOverride: { maxAsks: 2, windowDays: 91 },
    });
    assert.equal(second.rateLimitOverrideMaxAsks, 2);
    assert.equal(second.rateLimitOverrideWindowDays, 91);
  });

  it("boundaries are honored: never-ask blocks, monthly tightens the window", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield", {
      boundaries: "Never ask me for intros — retired from networking.",
    });
    const b = await addPerson(ws, "Alex Rivera");
    await assertThrowsCode(
      () => proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera"),
      "intro_blocked_by_boundaries",
    );

    const m = await addPerson(ws, "Maya Chen", {
      boundaries: "Don't ask for intros more than monthly.",
    });
    const t1 = await addPerson(ws, "Tom Baker");
    const t2 = await addPerson(ws, "Uma Patel");
    // First ask 40 days ago — outside the 31-day monthly window, so this propose is fine.
    const old = await store.proposeIntroduction(
      ws,
      {
        personAId: m,
        personBId: t1,
        introPath: pathSnapshot(m, "Maya Chen", t1, "Tom Baker"),
        draftAskMessage: "x".repeat(40),
        draftOfferMessage: "y".repeat(40),
      },
      {
        proposedBy: "connector-agent",
        proposerKind: "agent",
        now: new Date(NOW.getTime() - 40 * DAY),
      },
    );
    assert.equal(old.status, "proposed");
    // Backdate the row: the ask really went out 40 days ago.
    await prisma.connectorIntroduction.update({
      where: { id: old.id },
      data: { createdAt: new Date(NOW.getTime() - 40 * DAY) },
    });
    // Second ask now: only the 31-day window counts the old one, so this is the 2nd in-window ask → blocked.
    const recent = await store.proposeIntroduction(
      ws,
      {
        personAId: m,
        personBId: t2,
        introPath: pathSnapshot(m, "Maya Chen", t2, "Uma Patel"),
        draftAskMessage: "x".repeat(40),
        draftOfferMessage: "y".repeat(40),
      },
      { proposedBy: "connector-agent", proposerKind: "agent", now: NOW },
    );
    assert.equal(recent.status, "proposed");
    const t3 = await addPerson(ws, "Vera Lind");
    await assertThrowsCode(
      () =>
        store.proposeIntroduction(
          ws,
          {
            personAId: m,
            personBId: t3,
            introPath: pathSnapshot(m, "Maya Chen", t3, "Vera Lind"),
            draftAskMessage: "x".repeat(40),
            draftOfferMessage: "y".repeat(40),
          },
          { proposedBy: "connector-agent", proposerKind: "agent", now: NOW },
        ),
      "intro_rate_limited",
    );
  });
});

describe("slice 4 — one active intro per pair", () => {
  it("rejects a duplicate active pair; terminal states free the pair", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const first = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    // Same mutual → the rate limit fires first; override it so the request
    // reaches the one-active-per-pair check.
    await assertThrowsCode(
      () =>
        proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera", {
          rateLimitOverride: { maxAsks: 2, windowDays: 91 },
        }),
      "intro_already_active",
    );
    // Decline the first → the pair is free again (the tenant overrides the
    // rate limit per-instance to re-propose inside the same quarter).
    await store.declineByTenant(ws, first.id, { declinedBy: TENANT });
    const second = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera", {
      rateLimitOverride: { maxAsks: 2, windowDays: 91 },
    });
    assert.equal(second.status, "proposed");
  });
});

describe("slice 4 — expiry", () => {
  it("sweeps stale proposed intros to expired; leaves the rest alone", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const c = await addPerson(ws, "Priya Nair");
    const d = await addPerson(ws, "Sam Ortiz");

    const stale = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    await prisma.connectorIntroduction.update({
      where: { id: stale.id },
      data: { createdAt: new Date(NOW.getTime() - 15 * DAY) },
    });
    const fresh = await proposePair(ws, c, d, "Priya Nair", "Sam Ortiz");

    // An old but already-accepted intro must NOT expire (only proposed expires).
    const e = await addPerson(ws, "Eve Adams");
    const f = await addPerson(ws, "Frank Bell");
    const accepted = await proposePair(ws, e, f, "Eve Adams", "Frank Bell");
    await store.approveByTenant(ws, accepted.id, { approvedBy: TENANT, sentVia: "gmail" });
    await store.acceptSideA(ws, accepted.id, { kind: "human", identity: "eve@example.com" }, { sentVia: "gmail" });
    await prisma.connectorIntroduction.update({
      where: { id: accepted.id },
      data: { createdAt: new Date(NOW.getTime() - 30 * DAY) },
    });

    const result = await store.sweepExpiredIntroductions(ws, { expiryDays: 14, now: NOW });
    assert.equal(result.expired, 1);
    assert.deepEqual(result.ids, [stale.id]);

    const detail = await store.getIntroductionDetail(ws, stale.id);
    assert.equal(detail.status, "expired");
    assert.ok(detail.expiredAt);
    assert.equal(detail.events[detail.events.length - 1].kind, "expired");
    assert.equal(detail.events[detail.events.length - 1].actorKind, "system");

    assert.equal((await store.getIntroductionDetail(ws, fresh.id)).status, "proposed");
    assert.equal((await store.getIntroductionDetail(ws, accepted.id)).status, "side_a_accepted");

    // Expired is terminal: nothing moves out of it.
    await assertThrowsCode(
      () => store.approveByTenant(ws, stale.id, { approvedBy: TENANT, sentVia: "gmail" }),
      "invalid_transition",
    );
  });

  it("honors a custom expiry window", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    await prisma.connectorIntroduction.update({
      where: { id: intro.id },
      data: { createdAt: new Date(NOW.getTime() - 8 * DAY) },
    });
    const r = await store.sweepExpiredIntroductions(ws, { expiryDays: 30, now: NOW });
    assert.equal(r.expired, 0);
  });
});

describe("slice 4 — followup", () => {
  it("rejects followups before made", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    await assertThrowsCode(
      () => store.proposeFollowup(ws, intro.id, { draft: "x".repeat(40), to: "both" }, { proposedBy: "connector-agent" }),
      "invalid_transition",
    );
    await assertThrowsCode(
      () => store.approveFollowup(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" }),
      "invalid_transition",
    );
  });

  it("followup is a tenant-approved draft, sent once; more need tenant approval", async () => {
    const ws = await makeWorkspace();
    const { intro } = await happyPathToAccepted(ws);
    const made = await store.makeIntro(ws, intro.id, {
      message: "Dana — meet Alex. Alex — meet Dana. Over to you both!".repeat(2),
      sentVia: "gmail",
      sentBy: TENANT,
    });
    assert.equal(made.status, "made");

    const proposed = await store.proposeFollowup(
      ws,
      intro.id,
      { draft: "Hi you two — did you manage to connect? Happy to re-intro if timing was off.", to: "both" },
      { proposedBy: "connector-agent" },
    );
    assert.equal(proposed.status, "made"); // still made — the draft is pending
    assert.match(proposed.pendingFollowupDraft ?? "", /did you manage to connect/);

    // A second pending draft is rejected.
    await assertThrowsCode(
      () => store.proposeFollowup(ws, intro.id, { draft: "y".repeat(40), to: "side_a" }, { proposedBy: "connector-agent" }),
      "followup_pending",
    );

    const followed = await store.approveFollowup(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    assert.equal(followed.status, "followed_up");
    assert.equal(followed.followupCount, 1);
    assert.equal(followed.pendingFollowupDraft, null);

    const detail = await store.getIntroductionDetail(ws, intro.id);
    const kinds = detail.events.map((e) => e.kind);
    assert.deepEqual(kinds, [
      "proposed",
      "tenant_approved",
      "ask_sent_to_side_a",
      "side_a_accepted",
      "offer_sent_to_side_b",
      "side_b_accepted",
      "intro_sent",
      "followup_proposed",
      "followup_sent",
    ]);
    const sent = detail.events[detail.events.length - 1];
    assert.match(sent.message ?? "", /Dana Whitfield and Alex Rivera/);

    // A second followup is allowed — it goes through tenant approval again.
    await store.proposeFollowup(
      ws,
      intro.id,
      { draft: "Bumping this once — still happy to reconnect you two if useful.", to: "side_b" },
      { proposedBy: "connector-agent" },
    );
    const followed2 = await store.approveFollowup(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    assert.equal(followed2.followupCount, 2);
  });

  it("never follows up a declined intro", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    await store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    await store.acceptSideA(ws, intro.id, HUMAN_A, { sentVia: "gmail" });
    await store.declineSideB(ws, intro.id, HUMAN_B, { note: "Not raising right now." });
    await assertThrowsCode(
      () => store.proposeFollowup(ws, intro.id, { draft: "x".repeat(40), to: "side_a" }, { proposedBy: "connector-agent" }),
      "invalid_transition",
    );
  });
});

describe("slice 4 — withdraw", () => {
  it("withdraws from in-flight states; terminal states reject it", async () => {
    const ws = await makeWorkspace();
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b, "Dana Whitfield", "Alex Rivera");
    const withdrawn = await store.withdrawIntroduction(ws, intro.id, { withdrawnBy: TENANT });
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.withdrawnBy, TENANT);
    await assertThrowsCode(
      () => store.withdrawIntroduction(ws, intro.id, { withdrawnBy: TENANT }),
      "invalid_transition",
    );

    const a2 = await addPerson(ws, "Priya Nair");
    const b2 = await addPerson(ws, "Sam Ortiz");
    const intro2 = await proposePair(ws, a2, b2, "Priya Nair", "Sam Ortiz");
    await store.declineByTenant(ws, intro2.id, { declinedBy: TENANT });
    await assertThrowsCode(
      () => store.withdrawIntroduction(ws, intro2.id, { withdrawnBy: TENANT }),
      "invalid_transition",
    );
  });
});

describe("slice 4 — full lineage on the happy path", () => {
  it("records who proposed, who accepted, what was said, and when", async () => {
    const ws = await makeWorkspace();
    const { intro } = await happyPathToAccepted(ws);
    const made = await store.makeIntro(ws, intro.id, {
      message: "Dana — meet Alex. Alex — meet Dana. Over to you both!".repeat(2),
      sentVia: "gmail",
      sentBy: TENANT,
    });
    const detail = await store.getIntroductionDetail(ws, made.id);

    assert.equal(detail.sideAAcceptedBy, "dana@example.com");
    assert.ok(detail.sideAAcceptedAt);
    assert.equal(detail.sideBAcceptedBy, "alex@example.com");
    assert.ok(detail.sideBAcceptedAt);
    assert.equal(detail.madeSentBy, TENANT);

    const kinds = detail.events.map((e) => e.kind);
    assert.deepEqual(kinds, [
      "proposed",
      "tenant_approved",
      "ask_sent_to_side_a",
      "side_a_accepted",
      "offer_sent_to_side_b",
      "side_b_accepted",
      "intro_sent",
    ]);
    // Chronological.
    const times = detail.events.map((e) => e.createdAt.getTime());
    assert.deepEqual([...times].sort((x, y) => x - y), times);
    // Every event names its actor and carries the message.
    for (const e of detail.events) {
      assert.ok(e.actorIdentity.length > 0, `${e.kind} missing actor`);
      assert.ok((e.message ?? "").length > 0, `${e.kind} missing message`);
    }
  });
});
