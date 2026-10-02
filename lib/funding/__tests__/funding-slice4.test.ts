// Marketr — Funding/VC slice 4 tests: round readiness checklist, cap-table
// math, SAFE template picker, deterministic deck-review rubric.
// Run: npx tsx --test lib/funding/__tests__/funding-slice4.test.ts
//
// Pure tests run without a DB. DB-backed tests run against the local dev DB
// and clean up their own test workspaces.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaFundingStore } from "../prisma-store";
import { FundingError } from "../types";
import {
  CHECKLIST_KEYS,
  READINESS_CHECKLIST_TEMPLATE,
  emptyEvidence,
  formatPctBp,
  rollupCapTable,
  validateChecklistEvidence,
  validateChecklistItemUpdate,
  validateStakeholderInput,
} from "../readiness";
import {
  SAFE_TEMPLATES,
  SAFE_NOT_ADVICE_LABEL,
  getSafeTemplate,
  isSafeTemplateKey,
  validateSafeSelection,
} from "../safe-templates";
import {
  DECK_CRITERION_EXPECTATIONS,
  reviewDeck,
  validateDeckReviewInput,
} from "../deck-review";

const store = new PrismaFundingStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(tag: string): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-funding-slice4-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-funding-slice4",
    },
  });
  testWorkspaceIds.push(ws.id);
  return ws.id;
}

async function makeRound(ws: string) {
  return store.upsertRound(ws, { name: "Seed round", stages: ["seed"], sectors: ["dev-tools"] });
}

before(async () => {
  // no-op: workspaces created per test group
});

after(async () => {
  for (const id of testWorkspaceIds) {
    await prisma.workspace.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

// ------------------------------------------------------------------
// Pure: checklist transitions
// ------------------------------------------------------------------

describe("checklist template + transitions", () => {
  it("ships exactly the 7 spec'd keys", () => {
    assert.deepEqual([...CHECKLIST_KEYS], [
      "incorporation",
      "ein",
      "cap_table",
      "safe_template",
      "pitch_deck",
      "financials",
      "data_room_links",
    ]);
    assert.equal(READINESS_CHECKLIST_TEMPLATE.length, 7);
  });

  it("incorporation/ein items carry the read-only Legal cross-link hint", () => {
    const byKey = new Map(READINESS_CHECKLIST_TEMPLATE.map((t) => [t.key, t]));
    assert.deepEqual(byKey.get("incorporation")!.legalDocTypes, ["formation"]);
    assert.deepEqual(byKey.get("ein")!.legalDocTypes, ["ein_letter"]);
    assert.equal(byKey.get("cap_table")!.legalDocTypes, null);
  });

  it("accepts valid status moves", () => {
    const r = validateChecklistItemUpdate({ status: "doing" });
    assert.equal(r.status, "doing");
  });

  it("rejects unknown statuses", () => {
    assert.throws(() => validateChecklistItemUpdate({ status: "almost" }), FundingError);
  });

  it("waived requires a reason", () => {
    assert.throws(
      () => validateChecklistItemUpdate({ status: "waived", notes: "   " }),
      (e: unknown) => e instanceof FundingError && e.code === "WAIVE_NEEDS_REASON",
    );
    const ok = validateChecklistItemUpdate({ status: "waived", notes: "Incorporated as LLC in 2022, converting later." });
    assert.equal(ok.status, "waived");
  });

  it("evidence links need a label and a target", () => {
    assert.throws(
      () => validateChecklistEvidence({ links: [{ label: "Articles" }] }),
      /needs a target/,
    );
    assert.throws(
      () => validateChecklistEvidence({ links: [{ label: "", url: "https://x.com" }] }),
      /label is required/,
    );
    assert.throws(
      () => validateChecklistEvidence({ links: [{ label: "X", url: "ftp://x.com/f" }] }),
      /must be http/,
    );
    const ok = validateChecklistEvidence({
      links: [
        { label: "Articles of incorporation", legalDocumentId: "doc_1" },
        { label: "Deck v3", url: "https://example.com/deck.pdf" },
      ],
    });
    assert.equal(ok.links.length, 2);
  });

  it("emptyEvidence is a clean bag", () => {
    assert.deepEqual(emptyEvidence(), { links: [] });
  });
});

// ------------------------------------------------------------------
// Pure: cap-table math
// ------------------------------------------------------------------

describe("cap-table rollups", () => {
  it("rolls up a typical seed table", () => {
    const rows = [
      { id: "a", name: "Jane", type: "founder" as const, shares: BigInt(8000000), shareClass: "Common", vestingSummary: "4yr/1yr cliff" },
      { id: "b", name: "Acme VC", type: "investor" as const, shares: BigInt(2000000), shareClass: "Series Seed", vestingSummary: null },
      { id: "c", name: "Option pool", type: "employee" as const, shares: BigInt(1000000), shareClass: "Options", vestingSummary: null },
    ];
    const r = rollupCapTable(rows);
    assert.equal(r.totalShares, BigInt(11000000));
    assert.equal(r.pctByTypeBp.founder, 7272); // floor of 72.7272%
    assert.equal(r.pctByTypeBp.investor, 1818);
    assert.equal(r.pctByTypeBp.employee, 909);
    assert.equal(formatPctBp(7272), "72.72%");
    assert.equal(r.topHolder!.name, "Jane");
    assert.deepEqual(r.rowPctBp, [7272, 1818, 909]);
  });

  it("empty table rolls up to zeros (no divide-by-zero)", () => {
    const r = rollupCapTable([]);
    assert.equal(r.totalShares, BigInt(0));
    assert.equal(r.pctByTypeBp.founder, 0);
    assert.equal(r.topHolder, null);
    assert.equal(r.rowCount, 0);
  });

  it("single founder owns 100%", () => {
    const r = rollupCapTable([
      { id: "a", name: "Solo", type: "founder" as const, shares: BigInt(10000000), shareClass: null, vestingSummary: null },
    ]);
    assert.equal(r.pctByTypeBp.founder, 10_000);
    assert.equal(r.topHolder!.pctBp, 10_000);
  });

  it("handles zero-share rows and huge bigint counts", () => {
    const huge = BigInt("9999999999999999999"); // far beyond 2^31
    const r = rollupCapTable([
      { id: "a", name: "Big", type: "founder" as const, shares: huge, shareClass: null, vestingSummary: null },
      { id: "b", name: "Zero", type: "advisor" as const, shares: BigInt(0), shareClass: null, vestingSummary: null },
    ]);
    assert.equal(r.totalShares, huge);
    assert.equal(r.pctByTypeBp.founder, 10_000);
    assert.equal(r.pctByTypeBp.advisor, 0);
    assert.equal(r.topHolder!.name, "Big");
  });

  it("basis points always floor — never exceed 10000 total", () => {
    const r = rollupCapTable([
      { id: "a", name: "A", type: "founder" as const, shares: BigInt(1), shareClass: null, vestingSummary: null },
      { id: "b", name: "B", type: "founder" as const, shares: BigInt(1), shareClass: null, vestingSummary: null },
      { id: "c", name: "C", type: "founder" as const, shares: BigInt(1), shareClass: null, vestingSummary: null },
    ]);
    const sum = r.rowPctBp.reduce((s, x) => s + x, 0);
    assert.ok(sum <= 10_000, `row pct sum ${sum} must not exceed 10000`);
  });
});

describe("validateStakeholderInput", () => {
  it("accepts bigint-scale share counts", () => {
    const v = validateStakeholderInput({
      name: "Jane",
      type: "founder",
      shares: "10000000000",
      shareClass: "Common",
    });
    assert.equal(v.shares, BigInt("10000000000"));
  });

  it("rejects negative, fractional, and junk shares", () => {
    const isSharesErr = (e: unknown) => e instanceof FundingError && e.code === "INVALID_SHARES";
    assert.throws(() => validateStakeholderInput({ name: "X", type: "founder", shares: -5 }), isSharesErr);
    assert.throws(() => validateStakeholderInput({ name: "X", type: "founder", shares: 1.5 }), isSharesErr);
    assert.throws(() => validateStakeholderInput({ name: "X", type: "founder", shares: "lots" }), isSharesErr);
  });

  it("rejects bad type and blank name", () => {
    assert.throws(
      () => validateStakeholderInput({ name: "X", type: "angel", shares: 10 }),
      (e: unknown) => e instanceof FundingError && e.code === "INVALID_TYPE",
    );
    assert.throws(
      () => validateStakeholderInput({ name: "  ", type: "founder", shares: 10 }),
      (e: unknown) => e instanceof FundingError && e.code === "INVALID_NAME",
    );
  });
});

// ------------------------------------------------------------------
// Pure: SAFE templates
// ------------------------------------------------------------------

describe("SAFE template picker", () => {
  it("ships cap / discount / cap+discount / MFN variants", () => {
    assert.equal(SAFE_TEMPLATES.length, 4);
    assert.ok(isSafeTemplateKey("preseed_valuation_cap"));
    assert.ok(isSafeTemplateKey("seed_mfn"));
    assert.ok(!isSafeTemplateKey("series_a_priced"));
  });

  it("every template carries the not-advice label", () => {
    assert.match(SAFE_NOT_ADVICE_LABEL, /not legal advice/i);
    assert.match(SAFE_NOT_ADVICE_LABEL, /licensed attorney/i);
  });

  it("validates selections", () => {
    const ok = validateSafeSelection({ templateKey: "seed_cap_and_discount", valuationCapUsd: 8_000_000, discountPct: 20 });
    assert.equal(ok.templateKey, "seed_cap_and_discount");
    assert.equal(ok.valuationCapUsd, 8_000_000);
    const isTemplateErr = (e: unknown) => e instanceof FundingError && e.code === "INVALID_TEMPLATE";
    const isParamErr = (e: unknown) => e instanceof FundingError && e.code === "INVALID_SAFE_PARAM";
    assert.throws(() => validateSafeSelection({ templateKey: "nope" }), isTemplateErr);
    assert.throws(() => validateSafeSelection({ templateKey: "seed_mfn", valuationCapUsd: -1 }), isParamErr);
    assert.throws(() => validateSafeSelection({ templateKey: "seed_mfn", discountPct: 150 }), isParamErr);
  });

  it("getSafeTemplate resolves", () => {
    assert.equal(getSafeTemplate("preseed_discount").roundFit, "pre-seed");
    assert.throws(
      () => getSafeTemplate("x" as never),
      (e: unknown) => e instanceof FundingError && e.code === "INVALID_TEMPLATE",
    );
  });
});

// ------------------------------------------------------------------
// Pure: deterministic deck review
// ------------------------------------------------------------------

const DECK_TEXT = `
Acme AI — the problem: sales teams struggle with follow-up. Our customers
report a painful, manual challenge every quarter.
Traction: $120k MRR, growing 18% MoM, 240 customers, 3.2x NRR. Pilots with
two Fortune 500s. TAM $48 billion, SAM $6 billion.
Team: Jane (CEO, ex-Stripe), Bob (CTO, ex-Scale). Advisors from a16z.
We are raising a $2.5M seed round. Use of funds: hiring + GTM.
Financials: $90k burn, 26 months runway, 82% gross margin, LTV/CAC 4.1.
`;

describe("reviewDeck determinism", () => {
  const input = {
    fileName: "acme-deck.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1_240_000,
    versionNumber: 3,
    uploadedAt: "2026-10-01T12:00:00.000Z",
    deckText: DECK_TEXT,
  };

  it("same input -> byte-identical output and stable hash", () => {
    const a = reviewDeck(input);
    const b = reviewDeck(input);
    assert.deepEqual(a, b);
    assert.equal(a.inputHash, b.inputHash);
    assert.match(a.inputHash, /^[0-9a-f]{64}$/);
  });

  it("whitespace-only differences normalize to the same review", () => {
    const noisy = { ...input, deckText: DECK_TEXT.replace(/\n/g, "   \n  ") };
    assert.equal(reviewDeck(noisy).inputHash, reviewDeck(input).inputHash);
  });

  it("different text -> different hash and score", () => {
    const thin = reviewDeck({ ...input, deckText: "Hello world, this is a deck." });
    const full = reviewDeck(input);
    assert.notEqual(thin.inputHash, full.inputHash);
    assert.ok(thin.overallScore < full.overallScore);
  });

  it("scores the strong deck highly across all six criteria", () => {
    const out = reviewDeck(input);
    assert.equal(out.results.length, 6);
    for (const r of out.results) {
      assert.equal(r.verdict, "pass", `${r.criterion} should pass`);
      assert.equal(r.score, 2);
    }
    assert.equal(out.overallScore, 100);
    assert.equal(out.deckTextProvided, true);
  });

  it("no invention: without deck text every text criterion is not_detected", () => {
    const out = reviewDeck({ ...input, deckText: null });
    assert.equal(out.deckTextProvided, false);
    for (const r of out.results) {
      assert.equal(r.verdict, "not_detected", `${r.criterion} must not be guessed`);
      assert.equal(r.score, 0);
      // No text signals — only metadata provenance.
      assert.ok(r.signals.every((s) => s.source === "metadata"));
      assert.match(r.note, /Not detected/);
    }
    assert.ok(out.overallScore < 100);
    assert.match(out.narrative, /not detected/i);
  });

  it("every finding cites its signal; excerpts come from the deck text", () => {
    const out = reviewDeck(input);
    for (const r of out.results) {
      assert.ok(r.signals.length > 0, `${r.criterion} has no signals`);
      const textSignals = r.signals.filter((s) => s.source === "deck_text");
      assert.ok(textSignals.length > 0, `${r.criterion} cites no deck-text signal`);
      for (const s of textSignals) {
        assert.ok(s.excerpt && s.excerpt.length > 0 && s.excerpt.length <= 150);
        // The excerpt must actually appear in the normalized deck text.
        const core = s.excerpt.replace(/^…|…$/g, "").slice(0, 20);
        assert.ok(
          input.deckText.replace(/\s+/g, " ").includes(core.replace(/…$/, "")),
          `excerpt not found in deck text: ${core}`,
        );
      }
      // Metadata provenance is always attached.
      assert.ok(r.signals.some((s) => s.source === "metadata" && s.field === "fileName"));
    }
  });

  it("partial credit for thin coverage", () => {
    const out = reviewDeck({ ...input, deckText: "Our team is great. The team has experience." });
    const team = out.results.find((r) => r.criterion === "team")!;
    const traction = out.results.find((r) => r.criterion === "traction_evidence")!;
    // "team" + "experience" = 2 distinct signals -> pass; traction absent.
    assert.equal(team.verdict, "pass");
    assert.equal(traction.verdict, "not_detected");
  });

  it("criteria carry investor-pattern expectations", () => {
    for (const r of reviewDeck(input).results) {
      assert.ok(DECK_CRITERION_EXPECTATIONS[r.criterion].length > 20);
      assert.equal(r.maxScore, 2);
    }
  });

  it("validateDeckReviewInput caps text", () => {
    assert.deepEqual(validateDeckReviewInput({}), { deckText: null });
    assert.deepEqual(validateDeckReviewInput({ deckText: "  " }), { deckText: null });
    assert.throws(() => validateDeckReviewInput({ deckText: "x".repeat(100_001) }), FundingError);
    assert.throws(() => validateDeckReviewInput({ deckText: 42 }), FundingError);
  });
});

// ------------------------------------------------------------------
// DB-backed: checklist lifecycle
// ------------------------------------------------------------------

describe("checklist lifecycle (db)", () => {
  it("seeds 7 items idempotently and updates with completion stamps", async () => {
    const ws = await makeWorkspace("checklist");
    const round = await makeRound(ws);

    await store.ensureChecklist(ws, round.id);
    let { items } = await store.getReadiness(ws, round.id);
    assert.equal(items.length, 7);
    assert.ok(items.every((i) => i.status === "todo"));

    // Idempotent: no dupes on re-seed.
    await store.ensureChecklist(ws, round.id);
    ({ items } = await store.getReadiness(ws, round.id));
    assert.equal(items.length, 7);

    const inc = items.find((i) => i.key === "incorporation")!;
    const done = await store.updateChecklistItem(
      ws,
      inc.id,
      { status: "done", evidence: { links: [{ label: "Articles", legalDocumentId: "doc_1" }] } },
      "founder@example.com",
      new Date("2026-10-01T12:00:00Z"),
    );
    assert.equal(done.status, "done");
    assert.equal(done.completedAt?.toISOString(), "2026-10-01T12:00:00.000Z");
    assert.equal(done.completedBy, "founder@example.com");

    // Moving off done clears the stamp.
    const reopened = await store.updateChecklistItem(ws, inc.id, { status: "doing" }, "founder@example.com");
    assert.equal(reopened.status, "doing");
    assert.equal(reopened.completedAt, null);

    // Waiving without a reason fails even at the store layer.
    await assert.rejects(
      () => store.updateChecklistItem(ws, inc.id, { status: "waived", notes: "" }, "founder@example.com"),
      (e: unknown) => e instanceof FundingError && e.code === "WAIVE_NEEDS_REASON",
    );
    const waived = await store.updateChecklistItem(
      ws,
      inc.id,
      { status: "waived", notes: "LLC for now; converting at the priced round." },
      "founder@example.com",
    );
    assert.equal(waived.status, "waived");
  });

  it("readiness signals surface read-only Legal vault docs", async () => {
    const ws = await makeWorkspace("legal-signal");
    const round = await makeRound(ws);
    await prisma.legalDocument.create({
      data: { workspaceId: ws, docType: "formation", title: "Articles of Incorporation" },
    });
    const { signals } = await store.getReadiness(ws, round.id);
    assert.equal(signals.legalVault.formationDocs.length, 1);
    assert.equal(signals.legalVault.formationDocs[0].title, "Articles of Incorporation");
    assert.equal(signals.legalVault.einDocs.length, 0);
  });

  it("tenant scoping: another workspace cannot touch the checklist", async () => {
    const wsA = await makeWorkspace("scope-a");
    const wsB = await makeWorkspace("scope-b");
    const roundA = await makeRound(wsA);
    await store.ensureChecklist(wsA, roundA.id);
    const { items } = await store.getReadiness(wsA, roundA.id);

    await assert.rejects(
      () => store.getReadiness(wsB, roundA.id),
      (e: unknown) => e instanceof FundingError && e.code === "ROUND_NOT_FOUND",
    );
    await assert.rejects(
      () => store.updateChecklistItem(wsB, items[0].id, { status: "done" }, "x"),
      (e: unknown) => e instanceof FundingError && e.code === "CHECKLIST_ITEM_NOT_FOUND",
    );
  });
});

// ------------------------------------------------------------------
// DB-backed: link testing
// ------------------------------------------------------------------

describe("testDataRoomLinks (db)", () => {
  it("reports zero links honestly and flags revoked/expired", async () => {
    const ws = await makeWorkspace("links");
    const round = await makeRound(ws);

    const empty = await store.testDataRoomLinks(ws, round.id);
    assert.equal(empty.tested, 0);
    assert.equal(empty.passing, 0);

    const doc = await store.createDoc(ws, "founder@example.com", {
      title: "Deck",
      kind: "pitch_deck",
      fileName: "deck.pdf",
      fileBytes: Buffer.from("%PDF-1.4\n% test\n"),
      mimeType: "application/pdf",
    });
    const good = await store.createShareLink(ws, {
      docId: doc.id,
      docVersionId: null,
      viewerEmails: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const expired = await store.createShareLink(ws, {
      docId: doc.id,
      docVersionId: null,
      viewerEmails: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    // Force-expire + revoke via direct updates (the store has no
    // backdate path — access-time enforcement is what matters).
    await prisma.fundingShareLink.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const doomed = await store.createShareLink(ws, {
      docId: doc.id,
      docVersionId: null,
      viewerEmails: [],
      expiresAt: null,
    });
    await store.revokeShareLink(ws, doomed.id);

    const result = await store.testDataRoomLinks(ws, round.id);
    assert.equal(result.tested, 3);
    assert.equal(result.passing, 1);
    assert.equal(result.failing.length, 2);
    assert.deepEqual(
      result.failing.map((f) => f.reason).sort(),
      ["expired", "revoked"],
    );
    assert.ok(!result.failing.some((f) => f.linkId === good.id));

    // Evidence landed on the data_room_links item.
    const { items } = await store.getReadiness(ws, round.id);
    const links = items.find((i) => i.key === "data_room_links")!;
    assert.ok(links.evidence.testedAt);
    assert.match(links.evidence.note ?? "", /2 of 3 link\(s\) failing/);
  });
});

// ------------------------------------------------------------------
// DB-backed: cap table store
// ------------------------------------------------------------------

describe("cap table store (db)", () => {
  it("adds, lists with FD%, and deletes; tenant-scoped", async () => {
    const ws = await makeWorkspace("cap");
    const wsOther = await makeWorkspace("cap-other");
    const round = await makeRound(ws);

    const jane = await store.addStakeholder(ws, round.id, {
      name: "Jane",
      type: "founder",
      shares: "8000000",
      shareClass: "Common",
      vestingSummary: "4yr/1yr cliff",
    });
    await store.addStakeholder(ws, round.id, { name: "Acme VC", type: "investor", shares: 2_000_000 });
    // jane's view was computed when she was the sole row -> 100%.
    assert.equal(jane.fullyDilutedPctBp, 10_000);

    let { rows, rollup } = await store.listStakeholders(ws, round.id);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.name === "Jane")!.fullyDilutedPctBp, 8000);
    assert.equal(rows.length, 2);
    assert.equal(rollup.totalShares, "10000000");
    assert.equal(rollup.pctByTypeBp.founder, 8000);
    assert.equal(rollup.pctByTypeBp.investor, 2000);
    assert.equal(rollup.topHolder!.name, "Jane");

    // Cross-tenant reads/writes fail.
    await assert.rejects(
      () => store.listStakeholders(wsOther, round.id),
      (e: unknown) => e instanceof FundingError && e.code === "ROUND_NOT_FOUND",
    );
    await assert.rejects(
      () => store.deleteStakeholder(wsOther, jane.id),
      (e: unknown) => e instanceof FundingError && e.code === "STAKEHOLDER_NOT_FOUND",
    );

    await store.deleteStakeholder(ws, jane.id);
    ({ rows, rollup } = await store.listStakeholders(ws, round.id));
    assert.equal(rows.length, 1);
    assert.equal(rollup.pctByTypeBp.investor, 10_000);
  });

  it("updateStakeholder patches in place", async () => {
    const ws = await makeWorkspace("cap-update");
    const round = await makeRound(ws);
    const row = await store.addStakeholder(ws, round.id, { name: "Jane", type: "founder", shares: 1_000 });
    const updated = await store.updateStakeholder(ws, row.id, { shares: "2000" });
    assert.equal(updated.shares, "2000");
    assert.equal(updated.name, "Jane"); // untouched fields preserved
    assert.equal(updated.fullyDilutedPctBp, 10_000);
  });
});

// ------------------------------------------------------------------
// DB-backed: SAFE selection + deck review
// ------------------------------------------------------------------

describe("SAFE selection (db)", () => {
  it("records the pick as checklist evidence and marks the item done", async () => {
    const ws = await makeWorkspace("safe");
    const round = await makeRound(ws);
    const item = await store.selectSafeTemplate(
      ws,
      round.id,
      { templateKey: "seed_cap_and_discount", valuationCapUsd: 8_000_000, discountPct: 20 },
      "founder@example.com",
    );
    assert.equal(item.key, "safe_template");
    assert.equal(item.status, "done");
    assert.equal(item.evidence.safeTemplateKey, "seed_cap_and_discount");
    assert.equal(item.evidence.safeTemplateParams?.valuationCapUsd, 8_000_000);
    assert.ok(item.completedAt);

    await assert.rejects(
      () => store.selectSafeTemplate(ws, round.id, { templateKey: "bogus" }, "x"),
      (e: unknown) => e instanceof FundingError && e.code === "INVALID_TEMPLATE",
    );
  });
});

describe("runDeckReview (db)", () => {
  it("refuses without a pitch deck, then reviews the latest version", async () => {
    const ws = await makeWorkspace("review");
    const round = await makeRound(ws);

    await assert.rejects(
      () => store.runDeckReview(ws, round.id, { deckText: "problem problem" }),
      (e: unknown) => e instanceof FundingError && e.code === "NO_PITCH_DECK",
    );

    const deckText =
      "The problem: onboarding is a major pain point. Traction: $50k MRR, 12% MoM growth, 90 customers. " +
      "TAM $20 billion. Team: Jane CEO ex-Stripe. Raising $2M seed, use of funds: engineering. " +
      "Burn $70k, 24 months runway.";
    await store.createDoc(ws, "founder@example.com", {
      title: "Acme deck",
      kind: "pitch_deck",
      fileName: "acme-deck.pdf",
      fileBytes: Buffer.from("%PDF-1.4\n% deck\n"),
      mimeType: "application/pdf",
    });

    const review = await store.runDeckReview(ws, round.id, { deckText });
    assert.equal(review.overallScore, 100);
    assert.equal(review.results.length, 6);
    assert.equal(review.deckTextProvided, true);
    assert.match(review.inputHash, /^[0-9a-f]{64}$/);
    // Every result cites the deck text it came from.
    for (const r of review.results) {
      assert.ok(r.signals.some((s) => s.source === "deck_text" && s.excerpt));
    }

    const latest = await store.getLatestDeckReview(ws, round.id);
    assert.equal(latest!.id, review.id);

    // Deterministic across runs: same input, same hash.
    const again = await store.runDeckReview(ws, round.id, { deckText });
    assert.equal(again.inputHash, review.inputHash);
    assert.equal(again.overallScore, review.overallScore);
  });

  it("review is tenant-scoped", async () => {
    const wsA = await makeWorkspace("review-a");
    const wsB = await makeWorkspace("review-b");
    const roundA = await makeRound(wsA);
    await store.createDoc(wsA, "founder@example.com", {
      title: "Deck",
      kind: "pitch_deck",
      fileName: "d.pdf",
      fileBytes: Buffer.from("%PDF-1.4\n"),
    });
    await store.runDeckReview(wsA, roundA.id, {});
    assert.equal(await store.getLatestDeckReview(wsB, roundA.id).catch(() => "threw"), "threw");
  });
});
