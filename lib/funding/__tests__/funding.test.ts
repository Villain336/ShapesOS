// Marketr — Funding/VC slice 1 tests: starter network (Boardy preloaded),
// target investor profile validation, and intro-request guardrails.
// Run: npx tsx --test lib/funding/__tests__/funding.test.ts
//
// DB-backed tests (seeding idempotency, tenant scoping, guardrails) run
// against the local dev DB and clean up their own test workspaces.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaFundingStore } from "../prisma-store";
import {
  BOARDY_STARTER_CONTACT,
  validateStarterSeed,
} from "../seeds";
import {
  BOARDY_STARTER_KEY,
  FundingError,
  MAX_INTRO_REQUESTS_PER_CONTACT_PER_24H,
  validateIntroRequestInput,
  validateTargetInvestorProfile,
} from "../types";

const store = new PrismaFundingStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-funding-slice1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-funding-slice1",
    },
  });
  testWorkspaceIds.push(ws.id);
  return ws.id;
}

async function makeInvestor(workspaceId: string, name = "Test Investor") {
  return prisma.fundingInvestor.create({
    data: { workspaceId, name, firm: "Test Firm" },
  });
}

const GOOD_INTRO = {
  reason: "Partner at a fintech seed fund that led two dev-tools rounds this year",
  founderAsk: "A 20-minute intro call next week to walk through our seed deck",
};

describe("starter seed", () => {
  it("carries the Boardy identity markers", () => {
    assert.equal(BOARDY_STARTER_CONTACT.name, "Boardy");
    assert.equal(BOARDY_STARTER_CONTACT.role, "AI superconnector");
    assert.equal(BOARDY_STARTER_CONTACT.handle, "boardy@boardy.ai");
    assert.equal(BOARDY_STARTER_CONTACT.source, "boardy_starter");
    assert.equal(BOARDY_STARTER_CONTACT.isStarterContact, true);
    assert.equal(BOARDY_STARTER_CONTACT.starterKey, BOARDY_STARTER_KEY);
  });

  it("validates clean", () => {
    assert.deepEqual(validateStarterSeed(), []);
  });

  it("flags a corrupted seed", () => {
    const bad = { ...BOARDY_STARTER_CONTACT, name: "NotBoardy" };
    assert.ok(validateStarterSeed(bad).length > 0);
  });
});

describe("validateTargetInvestorProfile", () => {
  it("accepts a complete profile", () => {
    assert.deepEqual(
      validateTargetInvestorProfile({
        checkSizeMin: 25000,
        checkSizeMax: 250000,
        stages: ["pre-seed", "seed"],
        sectors: ["fintech"],
        thesisSummary: "Dev tools for fintech",
      }),
      [],
    );
  });

  it("rejects min larger than max", () => {
    const errors = validateTargetInvestorProfile({
      checkSizeMin: 500000,
      checkSizeMax: 100000,
    });
    assert.ok(errors.length > 0);
  });

  it("rejects negative check sizes", () => {
    assert.ok(validateTargetInvestorProfile({ checkSizeMin: -1 }).length > 0);
  });

  it("rejects blank stages/sectors entries and bad dates", () => {
    assert.ok(
      validateTargetInvestorProfile({ stages: ["seed", "  "] }).length > 0,
    );
    assert.ok(
      validateTargetInvestorProfile({ targetClose: "not-a-date" }).length > 0,
    );
  });

  it("accepts an empty profile (nothing required)", () => {
    assert.deepEqual(validateTargetInvestorProfile({}), []);
  });
});

describe("validateIntroRequestInput", () => {
  const base = {
    contactId: "c1",
    investorId: "i1",
    ...GOOD_INTRO,
  };

  it("accepts context-rich input", () => {
    assert.deepEqual(validateIntroRequestInput(base), []);
  });

  it("requires reason and founderAsk", () => {
    const errors = validateIntroRequestInput({
      ...base,
      reason: "   ",
      founderAsk: "",
    });
    assert.ok(errors.some((e) => e.includes("reason")));
    assert.ok(errors.some((e) => e.includes("founderAsk")));
  });

  it("rejects thin context (spray-and-pray guard)", () => {
    const errors = validateIntroRequestInput({
      ...base,
      reason: "he seems nice",
      founderAsk: "chat?",
    });
    assert.ok(errors.length >= 2);
  });
});

describe("ensureStarterContact (DB)", () => {
  let wsA: string;
  let wsB: string;

  before(async () => {
    wsA = await makeWorkspace();
    wsB = await makeWorkspace();
  });

  it("inserts Boardy as the starter contact on first init", async () => {
    const { contact, created } = await store.ensureStarterContact(wsA);
    assert.equal(created, true);
    assert.equal(contact.name, "Boardy");
    assert.equal(contact.role, "AI superconnector");
    assert.equal(contact.handle, "boardy@boardy.ai");
    assert.equal(contact.source, "boardy_starter");
    assert.equal(contact.isStarterContact, true);
  });

  it("is idempotent — re-run returns the same row, never a duplicate", async () => {
    const first = await store.ensureStarterContact(wsA);
    const second = await store.ensureStarterContact(wsA);
    assert.equal(second.created, false);
    assert.equal(first.contact.id, second.contact.id);
    const count = await prisma.fundingContact.count({
      where: { workspaceId: wsA, starterKey: BOARDY_STARTER_KEY },
    });
    assert.equal(count, 1);
  });

  it("is tenant-scoped — each workspace gets its own Boardy", async () => {
    const b = await store.ensureStarterContact(wsB);
    assert.equal(b.created, true);
    const aContacts = await store.listContacts(wsA);
    const bContacts = await store.listContacts(wsB);
    assert.ok(aContacts.every((c) => c.id !== b.contact.id));
    assert.equal(bContacts.length, 1);
  });

  it("lists the starter contact first", async () => {
    await prisma.fundingContact.create({
      data: { workspaceId: wsA, name: "Founder Friend", source: "founder_added" },
    });
    const contacts = await store.listContacts(wsA);
    assert.equal(contacts[0].isStarterContact, true);
    assert.equal(contacts[0].name, "Boardy");
  });
});

describe("upsertRound (DB)", () => {
  let ws: string;

  before(async () => {
    ws = await makeWorkspace();
  });

  it("saves the target investor profile as the active round", async () => {
    const round = await store.upsertRound(ws, {
      name: "Seed round",
      checkSizeMin: 25000,
      checkSizeMax: 250000,
      stages: ["pre-seed", "seed"],
      sectors: ["fintech", "dev-tools"],
      thesisSummary: "AI-native fintech tooling",
    });
    assert.equal(round.isActive, true);
    assert.equal(round.name, "Seed round");
    assert.deepEqual(round.stages, ["pre-seed", "seed"]);
    assert.deepEqual(round.sectors, ["fintech", "dev-tools"]);
    assert.equal(round.thesisSummary, "AI-native fintech tooling");
  });

  it("keeps exactly one active round per tenant", async () => {
    await store.upsertRound(ws, { name: "Bridge round" });
    const active = await prisma.fundingRound.findMany({
      where: { workspaceId: ws, isActive: true },
    });
    assert.equal(active.length, 1);
    assert.equal(active[0].name, "Bridge round");
    const fetched = await store.getActiveRound(ws);
    assert.equal(fetched?.name, "Bridge round");
  });

  it("rejects an invalid profile", async () => {
    await assert.rejects(
      () => store.upsertRound(ws, { checkSizeMin: 999, checkSizeMax: 1 }),
      (e: unknown) => e instanceof FundingError && e.code === "invalid_round",
    );
  });
});

describe("createIntroRequest guardrails (DB)", () => {
  let ws: string;
  let boardyId: string;

  before(async () => {
    ws = await makeWorkspace();
    const { contact } = await store.ensureStarterContact(ws);
    boardyId = contact.id;
  });

  it("rejects context-free requests", async () => {
    const investor = await makeInvestor(ws);
    await assert.rejects(
      () =>
        store.createIntroRequest(ws, {
          contactId: boardyId,
          investorId: investor.id,
          reason: "too short",
          founderAsk: "chat?",
        }),
      (e: unknown) =>
        e instanceof FundingError && e.code === "invalid_intro_request",
    );
  });

  it("rejects contacts/investors from another workspace (tenant scoping)", async () => {
    const otherWs = await makeWorkspace();
    const { contact: otherBoardy } = await store.ensureStarterContact(otherWs);
    const investor = await makeInvestor(ws);
    await assert.rejects(
      () =>
        store.createIntroRequest(ws, {
          contactId: otherBoardy.id,
          investorId: investor.id,
          ...GOOD_INTRO,
        }),
      (e: unknown) =>
        e instanceof FundingError && e.code === "contact_not_found",
    );
  });

  it("enforces one request per (contact, investor) pair", async () => {
    const investor = await makeInvestor(ws, "Pair Investor");
    const first = await store.createIntroRequest(ws, {
      contactId: boardyId,
      investorId: investor.id,
      ...GOOD_INTRO,
    });
    assert.equal(first.status, "draft");
    await assert.rejects(
      () =>
        store.createIntroRequest(ws, {
          contactId: boardyId,
          investorId: investor.id,
          ...GOOD_INTRO,
        }),
      (e: unknown) =>
        e instanceof FundingError && e.code === "duplicate_intro_request",
    );
  });

  it("rate-limits intro requests per contact per 24h", async () => {
    const limit = MAX_INTRO_REQUESTS_PER_CONTACT_PER_24H;
    const existing = await prisma.fundingIntroRequest.count({
      where: { workspaceId: ws, contactId: boardyId },
    });
    const needed = limit - existing;
    for (let i = 0; i < needed; i++) {
      const investor = await makeInvestor(ws, `Rate Investor ${i}`);
      await store.createIntroRequest(ws, {
        contactId: boardyId,
        investorId: investor.id,
        ...GOOD_INTRO,
      });
    }
    const extra = await makeInvestor(ws, "Rate Investor extra");
    await assert.rejects(
      () =>
        store.createIntroRequest(ws, {
          contactId: boardyId,
          investorId: extra.id,
          ...GOOD_INTRO,
        }),
      (e: unknown) => e instanceof FundingError && e.code === "rate_limited",
    );
  });
});

after(async () => {
  // Cascade deletes the funding rows with the workspace.
  await prisma.workspace.deleteMany({
    where: { id: { in: testWorkspaceIds } },
  });
  await prisma.$disconnect();
});
