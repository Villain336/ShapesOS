// Marketr — Connector Agent slice 5 tests: Modes + Funding/VC plug-in.
// Run: npx tsx --test lib/connector/__tests__/connector-slice5.test.ts
//
// Pure domain tests pin the mode law, the mode-scoped target filter, and
// the data-room offer copy. DB-backed tests run against the local dev DB
// and clean up their own test workspaces (cascades purge connector +
// funding rows).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaConnectorStore } from "../prisma-store";
import { PrismaIntroductionStore } from "../introduction-store";
import { PrismaFundingStore } from "../../funding/prisma-store";
import { ConnectorError } from "../types";
import {
  assertProposalModeLaw,
  companyRelationshipAllowedInMode,
  validateConnectorMode,
  type ConnectorMode,
} from "../modes";
import {
  buildDataRoomOfferLine,
  writebackIntroductionMade,
} from "../funding-plugin";
import {
  validateProposeIntroductionInput,
  type IntroActor,
} from "../introductions";

const personStore = new PrismaConnectorStore(prisma);
const store = new PrismaIntroductionStore(prisma);
const fundingStore = new PrismaFundingStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(tag: string): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-connector-slice5-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-connector-slice5",
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

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

async function addPerson(ws: string, name: string): Promise<string> {
  const p = await personStore.addPerson(ws, { name, consentedBy: "slice5-test" });
  return p.id;
}

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
  extra: Record<string, unknown> = {},
) {
  return store.proposeIntroduction(
    ws,
    {
      personAId: mutualId,
      personBId: targetId,
      introPath: pathSnapshot(mutualId, "Mutual", targetId, "Target"),
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

async function makeInvestor(ws: string, name = "Sequoia Scout") {
  const inv = await fundingStore.createInvestor(ws, {
    name,
    firm: "Sequoia",
    email: "scout@sequoia.example",
  });
  return fundingStore.updateInvestorEnrichment(ws, inv.id, {
    firm: "Sequoia",
    title: "Partner",
    email: "scout@sequoia.example",
    checkSizeMin: 250_000,
    checkSizeMax: 2_000_000,
    stages: ["seed"],
    sectors: ["devtools"],
    thesisFit: "AI infra tooling",
  });
}

const pdf = (tag: string) =>
  Buffer.from(`%PDF-1.4\n% data-room test ${tag}\n1 0 obj<</>>endobj\n`);

async function makeDeck(ws: string, tag: string) {
  return fundingStore.createDoc(ws, "founder@example.com", {
    title: `Deck ${tag}`,
    kind: "pitch_deck",
    fileName: `deck-${tag}.pdf`,
    fileBytes: pdf(tag),
    mimeType: "application/pdf",
  });
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
// Pure domain: mode law.
// ---------------------------------------------------------------------------

describe("slice 5 — mode validation + mode law (pure)", () => {
  it("validateConnectorMode accepts leads/funding, absent = use tenant setting", () => {
    assert.equal(validateConnectorMode("leads").value, "leads");
    assert.equal(validateConnectorMode("FUNDING").value, "funding");
    assert.equal(validateConnectorMode(null).value, null);
    assert.equal(validateConnectorMode("").value, null);
    const bad = validateConnectorMode("cold");
    assert.equal(bad.value, null);
    assert.ok(bad.errors.length > 0);
  });

  it("companyRelationshipAllowedInMode: funding = investors only; leads = buyers/partners", () => {
    assert.ok(companyRelationshipAllowedInMode("investor", "funding"));
    assert.ok(!companyRelationshipAllowedInMode("customer", "funding"));
    assert.ok(!companyRelationshipAllowedInMode("prospect", "funding"));
    assert.ok(!companyRelationshipAllowedInMode("partner", "funding"));
    assert.ok(!companyRelationshipAllowedInMode(null, "funding"));
    assert.ok(companyRelationshipAllowedInMode("customer", "leads"));
    assert.ok(companyRelationshipAllowedInMode("prospect", "leads"));
    assert.ok(companyRelationshipAllowedInMode("partner", "leads"));
    assert.ok(!companyRelationshipAllowedInMode("investor", "leads"));
    assert.ok(!companyRelationshipAllowedInMode("vendor", "leads"));
    assert.ok(!companyRelationshipAllowedInMode(null, "leads"));
  });

  it("assertProposalModeLaw: fundingInvestorId only legal in funding mode", () => {
    assert.doesNotThrow(() =>
      assertProposalModeLaw({ mode: "funding", fundingInvestorId: "inv_1" }),
    );
    assert.doesNotThrow(() =>
      assertProposalModeLaw({ mode: "funding", fundingInvestorId: null }),
    );
    assert.doesNotThrow(() =>
      assertProposalModeLaw({ mode: "leads", fundingInvestorId: null }),
    );
    assert.throws(
      () => assertProposalModeLaw({ mode: "leads", fundingInvestorId: "inv_1" }),
      (e: unknown) => e instanceof ConnectorError && e.code === "mode_mismatch",
    );
  });

  it("buildDataRoomOfferLine embeds the real link, never a placeholder", () => {
    const line = buildDataRoomOfferLine({
      shareLinkId: "sl_1",
      urlPath: "/r/funding/fsr_abc123",
      docTitle: "Seed deck",
      wholeRoom: false,
    });
    assert.ok(line.includes("/r/funding/fsr_abc123"));
    assert.ok(line.includes("Seed deck"));
    assert.ok(!line.includes("example.com"));
    assert.ok(!line.includes("placeholder"));
    assert.ok(!line.includes("TODO"));
    const room = buildDataRoomOfferLine({
      shareLinkId: "sl_2",
      urlPath: "/r/funding/fsr_def456",
      docTitle: null,
      wholeRoom: true,
    });
    assert.ok(room.includes("/r/funding/fsr_def456"));
    assert.ok(!room.includes("null"));
  });

  it("validateProposeIntroductionInput: mode/funding/dataroom rules", () => {
    const base = {
      personAId: "a",
      personBId: "b",
      introPath: { mutual: { id: "a" }, target: { id: "b" } },
      draftAskMessage:
        "This is a long-enough draft ask message for the mutual contact.",
      draftOfferMessage:
        "This is a long-enough draft offer message for the target contact.",
    };
    // Default mode is leads.
    assert.equal(validateProposeIntroductionInput(base).value?.mode, "leads");
    // fundingInvestorId in leads mode → error.
    const leadsBad = validateProposeIntroductionInput({
      ...base,
      fundingInvestorId: "inv_1",
    });
    assert.equal(leadsBad.value, null);
    assert.ok(leadsBad.errors.some((e) => e.includes("FUNDING")));
    // funding mode + investor → ok.
    const fundOk = validateProposeIntroductionInput({
      ...base,
      mode: "funding",
      fundingInvestorId: "inv_1",
    });
    assert.equal(fundOk.value?.mode, "funding");
    assert.equal(fundOk.value?.fundingInvestorId, "inv_1");
    // Bad mode → error.
    const badMode = validateProposeIntroductionInput({ ...base, mode: "cold" });
    assert.equal(badMode.value, null);
    // dataRoomOffer in leads mode → error.
    const leadsOffer = validateProposeIntroductionInput({
      ...base,
      dataRoomOffer: true,
    });
    assert.equal(leadsOffer.value, null);
    // dataRoomOffer in funding mode → parsed.
    const fundOffer = validateProposeIntroductionInput({
      ...base,
      mode: "funding",
      dataRoomOffer: { expiresInDays: 14 },
    });
    assert.equal(fundOffer.value?.dataRoomOffer?.expiresInDays, 14);
    assert.equal(fundOffer.value?.dataRoomOffer?.docId, null);
    // Bad expiry → error.
    const badExpiry = validateProposeIntroductionInput({
      ...base,
      mode: "funding",
      dataRoomOffer: { expiresInDays: 0 },
    });
    assert.equal(badExpiry.value, null);
  });
});

// ---------------------------------------------------------------------------
// DB: mode setting + mode-scoped targets.
// ---------------------------------------------------------------------------

describe("slice 5 — mode setting + mode-scoped targets (DB)", () => {
  it("getMode defaults to leads; setMode persists; tenant isolation", async () => {
    const wsA = await makeWorkspace("mode-a");
    const wsB = await makeWorkspace("mode-b");
    const def = await personStore.getMode(wsA);
    assert.equal(def.mode, "leads");

    const set = await personStore.setMode(wsA, "funding");
    assert.equal(set.mode, "funding");
    assert.equal((await personStore.getMode(wsA)).mode, "funding");
    // Tenant B untouched.
    assert.equal((await personStore.getMode(wsB)).mode, "leads");

    await assertThrowsCode(
      () => personStore.setMode(wsA, "cold" as ConnectorMode),
      "invalid_mode",
    );
  });

  it("listTargets: leads sees buyers/partners, never investors or the CRM", async () => {
    const ws = await makeWorkspace("targets-leads");
    await personStore.addCompany(ws, { name: "Acme Corp", relationship: "customer" });
    await personStore.addCompany(ws, { name: "Beta LLC", relationship: "prospect" });
    await personStore.addCompany(ws, { name: "Gamma Partners", relationship: "partner" });
    await personStore.addCompany(ws, { name: "VC Fund", relationship: "investor" });
    await personStore.addCompany(ws, { name: "Vendor Co", relationship: "vendor" });
    await makeInvestor(ws);

    const targets = await personStore.listTargets(ws, "leads");
    assert.equal(targets.mode, "leads");
    const names = targets.companies.map((c) => c.name).sort();
    assert.deepEqual(names, ["Acme Corp", "Beta LLC", "Gamma Partners"]);
    assert.equal(targets.investors.length, 0);
  });

  it("listTargets: funding sees investors + investor CRM (read-only), never buyers", async () => {
    const ws = await makeWorkspace("targets-funding");
    await personStore.addCompany(ws, { name: "Acme Corp", relationship: "customer" });
    await personStore.addCompany(ws, { name: "VC Fund", relationship: "investor" });
    const inv = await makeInvestor(ws);

    const targets = await personStore.listTargets(ws, "funding");
    assert.equal(targets.mode, "funding");
    assert.deepEqual(
      targets.companies.map((c) => c.name),
      ["VC Fund"],
    );
    assert.equal(targets.investors.length, 1);
    const t = targets.investors[0];
    assert.equal(t.id, inv.id);
    assert.equal(t.name, "Sequoia Scout");
    assert.equal(t.firm, "Sequoia");
    assert.equal(t.checkSizeMin, 250_000);
    assert.equal(t.checkSizeMax, 2_000_000);
    assert.deepEqual(t.stages, ["seed"]);
    assert.equal(t.thesisFit, "AI infra tooling");
    assert.equal(t.stage, "target");
  });

  it("listTargets defaults to the tenant setting; tenant isolation proven", async () => {
    const wsA = await makeWorkspace("targets-def-a");
    const wsB = await makeWorkspace("targets-def-b");
    await personStore.addCompany(wsA, { name: "VC Fund A", relationship: "investor" });
    await personStore.addCompany(wsB, { name: "VC Fund B", relationship: "investor" });
    await makeInvestor(wsA);
    await makeInvestor(wsB);
    await personStore.setMode(wsA, "funding");

    const a = await personStore.listTargets(wsA);
    assert.equal(a.mode, "funding");
    assert.deepEqual(a.companies.map((c) => c.name), ["VC Fund A"]);
    assert.equal(a.investors.length, 1);

    const b = await personStore.listTargets(wsB);
    assert.equal(b.mode, "leads");
    assert.equal(b.companies.length, 0);
    assert.equal(b.investors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// DB: mode-scoped path-finding.
// ---------------------------------------------------------------------------

describe("slice 5 — mode-scoped path-finding (DB)", () => {
  it("company targets are mode-gated: mismatch → mode_target_mismatch", async () => {
    const ws = await makeWorkspace("paths-mode");
    const buyer = await personStore.addCompany(ws, { name: "Buyer Inc", relationship: "customer" });
    const vc = await personStore.addCompany(ws, { name: "VC Fund", relationship: "investor" });

    await assertThrowsCode(
      () =>
        personStore.computeIntroPaths(ws, {
          targetCompanyId: buyer.id,
          mode: "funding",
        }),
      "mode_target_mismatch",
    );
    await assertThrowsCode(
      () =>
        personStore.computeIntroPaths(ws, {
          targetCompanyId: vc.id,
          mode: "leads",
        }),
      "mode_target_mismatch",
    );
    // Legal combos don't throw the mode error (no paths expected — no
    // mutuals — but the target resolves fine).
    const ok = await personStore.computeIntroPaths(ws, {
      targetCompanyId: vc.id,
      mode: "funding",
    });
    assert.ok(ok.result);
    // No mode → tenant setting applies (default leads → buyer ok).
    const def = await personStore.computeIntroPaths(ws, {
      targetCompanyId: buyer.id,
    });
    assert.ok(def.result);
  });
});

// ---------------------------------------------------------------------------
// DB: proposals — mode + investor link + data-room offer.
// ---------------------------------------------------------------------------

describe("slice 5 — proposals: mode + investor link (DB)", () => {
  it("funding proposal links the investor; view carries mode + investor", async () => {
    const ws = await makeWorkspace("propose-funding");
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const inv = await makeInvestor(ws);
    const intro = await proposePair(ws, a, b, {
      mode: "funding",
      fundingInvestorId: inv.id,
    });
    assert.equal(intro.mode, "funding");
    assert.equal(intro.fundingInvestorId, inv.id);
    assert.equal(intro.fundingInvestor?.name, "Sequoia Scout");
    assert.equal(intro.fundingInvestor?.firm, "Sequoia");

    const listed = await store.listIntroductions(ws, { mode: "funding" });
    assert.equal(listed.length, 1);
    const leadsListed = await store.listIntroductions(ws, { mode: "leads" });
    assert.equal(leadsListed.length, 0);
  });

  it("leads proposal + fundingInvestorId → rejected (mode law)", async () => {
    const ws = await makeWorkspace("propose-leads-bad");
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const inv = await makeInvestor(ws);
    await assertThrowsCode(
      () => proposePair(ws, a, b, { mode: "leads", fundingInvestorId: inv.id }),
      "invalid_introduction",
    );
  });

  it("foreign investor id → funding_investor_not_found (tenant isolation)", async () => {
    const wsA = await makeWorkspace("propose-iso-a");
    const wsB = await makeWorkspace("propose-iso-b");
    const a = await addPerson(wsA, "Dana Whitfield");
    const b = await addPerson(wsA, "Alex Rivera");
    const foreign = await makeInvestor(wsB);
    await assertThrowsCode(
      () =>
        proposePair(wsA, a, b, { mode: "funding", fundingInvestorId: foreign.id }),
      "funding_investor_not_found",
    );
  });

  it("dataRoomOffer mints a REAL share link into the draft (never a placeholder)", async () => {
    const ws = await makeWorkspace("propose-dataroom");
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const inv = await makeInvestor(ws);
    const deck = await makeDeck(ws, "slice5");

    const intro = await proposePair(ws, a, b, {
      mode: "funding",
      fundingInvestorId: inv.id,
      dataRoomOffer: true,
    });
    assert.ok(intro.dataRoomShareLinkId, "share link id recorded on the intro");
    assert.ok(
      intro.draftOfferMessage.includes("/r/funding/fsr_"),
      `draft carries the real token URL, got: ${intro.draftOfferMessage.slice(-120)}`,
    );
    assert.ok(!intro.draftOfferMessage.includes("placeholder"));
    assert.ok(!intro.draftOfferMessage.includes("example.com"));
    assert.ok(intro.draftOfferMessage.includes("Seed deck") || intro.draftOfferMessage.includes("data room"));

    // The link row really exists and points at the deck.
    const link = await prisma.fundingShareLink.findUnique({
      where: { id: intro.dataRoomShareLinkId as string },
      include: { doc: { select: { title: true, id: true } } },
    });
    assert.ok(link);
    assert.equal(link?.doc?.id, deck.id);
    assert.equal(link?.workspaceId, ws);
    assert.ok(!link?.revoked);
  });

  it("dataRoomOffer in leads mode → rejected", async () => {
    const ws = await makeWorkspace("propose-dataroom-leads");
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    await assertThrowsCode(
      () => proposePair(ws, a, b, { mode: "leads", dataRoomOffer: true }),
      "invalid_introduction",
    );
  });

  it("dataRoomOffer with no docs → whole-room link (still real)", async () => {
    const ws = await makeWorkspace("propose-dataroom-room");
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const inv = await makeInvestor(ws);
    const intro = await proposePair(ws, a, b, {
      mode: "funding",
      fundingInvestorId: inv.id,
      dataRoomOffer: true,
    });
    assert.ok(intro.dataRoomShareLinkId);
    assert.ok(intro.draftOfferMessage.includes("/r/funding/fsr_"));
    const link = await prisma.fundingShareLink.findUnique({
      where: { id: intro.dataRoomShareLinkId as string },
    });
    assert.equal(link?.docId, null); // whole-room link
  });
});

// ---------------------------------------------------------------------------
// DB: raise-workflow writeback on made.
// ---------------------------------------------------------------------------

describe("slice 5 — raise-workflow writeback (DB)", () => {
  async function fundingHappyPath(ws: string) {
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const inv = await makeInvestor(ws);
    let intro = await proposePair(ws, a, b, {
      mode: "funding",
      fundingInvestorId: inv.id,
    });
    intro = await store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    intro = await store.acceptSideA(ws, intro.id, HUMAN_A, { sentVia: "gmail" });
    intro = await store.acceptSideB(ws, intro.id, HUMAN_B);
    intro = await store.makeIntro(ws, intro.id, {
      message: "Dana — meet Alex. Alex — meet Dana. You two should talk seed rounds.",
      sentVia: "gmail",
      sentBy: TENANT,
    });
    return { intro, inv };
  }

  it("made in funding mode writes an intro interaction + advances target → contacted", async () => {
    const ws = await makeWorkspace("writeback-happy");
    const { intro, inv } = await fundingHappyPath(ws);

    const detail = await fundingStore.getInvestorDetail(ws, inv.id);
    assert.equal(detail.investor.stage, "contacted");
    const kinds = detail.interactions.map((i) => i.kind);
    assert.ok(kinds.includes("intro"), `expected an intro interaction, got: ${kinds.join(",")}`);
    assert.ok(kinds.includes("stage_change"), `expected a stage_change interaction, got: ${kinds.join(",")}`);
    const introInteraction = detail.interactions.find((i) => i.kind === "intro");
    assert.ok(introInteraction?.summary.includes("Dana Whitfield"));
    assert.ok(introInteraction?.summary.includes("Alex Rivera"));

    // Writeback lineage on the introduction's event log.
    const full = await store.getIntroductionDetail(ws, intro.id);
    const wb = full.events.find((e) => e.kind === "funding_writeback");
    assert.ok(wb, "funding_writeback event recorded");
    assert.ok(wb?.message?.includes("contacted"));
  });

  it("leads-mode made intros never touch the raise workflow", async () => {
    const ws = await makeWorkspace("writeback-leads");
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const inv = await makeInvestor(ws);
    let intro = await proposePair(ws, a, b); // default mode: leads
    intro = await store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    intro = await store.acceptSideA(ws, intro.id, HUMAN_A, { sentVia: "gmail" });
    intro = await store.acceptSideB(ws, intro.id, HUMAN_B);
    intro = await store.makeIntro(ws, intro.id, {
      message: "Dana — meet Alex. Alex — meet Dana. Buyer intro, nothing to do with the raise.",
      sentVia: "gmail",
      sentBy: TENANT,
    });

    const detail = await fundingStore.getInvestorDetail(ws, inv.id);
    assert.equal(detail.investor.stage, "target");
    assert.equal(detail.interactions.length, 0);

    const full = await store.getIntroductionDetail(ws, intro.id);
    assert.ok(!full.events.some((e) => e.kind === "funding_writeback"));
    assert.ok(!full.events.some((e) => e.kind === "funding_writeback_failed"));
  });

  it("writeback does not re-advance an investor already past target", async () => {
    const ws = await makeWorkspace("writeback-advanced");
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const inv = await makeInvestor(ws);
    await fundingStore.transitionStage(ws, inv.id, "contacted", TENANT);
    const before = await fundingStore.getInvestorDetail(ws, inv.id);
    const stageChangesBefore = before.interactions.filter((i) => i.kind === "stage_change").length;

    let intro = await proposePair(ws, a, b, { mode: "funding", fundingInvestorId: inv.id });
    intro = await store.approveByTenant(ws, intro.id, { approvedBy: TENANT, sentVia: "gmail" });
    intro = await store.acceptSideA(ws, intro.id, HUMAN_A, { sentVia: "gmail" });
    intro = await store.acceptSideB(ws, intro.id, HUMAN_B);
    await store.makeIntro(ws, intro.id, {
      message: "Dana — meet Alex. Alex — meet Dana. Follow-up intro to an already-contacted investor.",
      sentVia: "gmail",
      sentBy: TENANT,
    });

    const after = await fundingStore.getInvestorDetail(ws, inv.id);
    assert.equal(after.investor.stage, "contacted");
    assert.equal(
      after.interactions.filter((i) => i.kind === "stage_change").length,
      stageChangesBefore,
      "no duplicate stage_change recorded",
    );
    assert.ok(after.interactions.some((i) => i.kind === "intro"));
  });

  it("writebackIntroductionMade is a no-op for unlinked intros (direct call)", async () => {
    const ws = await makeWorkspace("writeback-noop");
    const a = await addPerson(ws, "Dana Whitfield");
    const b = await addPerson(ws, "Alex Rivera");
    const intro = await proposePair(ws, a, b);
    const result = await writebackIntroductionMade(prisma, ws, intro.id, {
      sentBy: TENANT,
    });
    assert.equal(result.written, false);
  });
});
