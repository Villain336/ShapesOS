// Marketr — Connector Agent slice 1 tests: graph core.
// Run: npx tsx --test lib/connector/__tests__/connector-slice1.test.ts
//
// DB-backed tests run against the local dev DB and clean up their own test
// workspaces (cascades purge connector rows).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaConnectorStore } from "../prisma-store";
import {
  ConnectorError,
  WARMTH_FREQUENCY_BANDS,
  WARMTH_RECENCY_BANDS,
  WARMTH_RECIPROCITY_BANDS,
  WARMTH_WEIGHTS,
  computeWarmth,
  validateCompanyInput,
  validateImportBatchInput,
  validatePersonInput,
  validateTouchInput,
} from "../types";

const store = new PrismaConnectorStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-connector-slice1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-connector-slice1",
    },
  });
  testWorkspaceIds.push(ws.id);
  return ws.id;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-01T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ConnectorError, `expected ConnectorError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a ConnectorError to be thrown");
}

after(async () => {
  for (const id of testWorkspaceIds) {
    await prisma.workspace.delete({ where: { id } }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Warmth math — pure, exact scores.
// ---------------------------------------------------------------------------

describe("computeWarmth", () => {
  it("weights sum to 100", () => {
    assert.equal(
      WARMTH_WEIGHTS.recency + WARMTH_WEIGHTS.frequency + WARMTH_WEIGHTS.reciprocity,
      100,
    );
  });

  it("fresh, frequent, reciprocal contact scores 100", () => {
    const b = computeWarmth(
      { lastTouchAt: daysAgo(3), touchCount: 12, inboundCount: 7, outboundCount: 5 },
      NOW,
    );
    assert.deepEqual(
      { recency: b.recency, frequency: b.frequency, reciprocity: b.reciprocity },
      { recency: 50, frequency: 30, reciprocity: 20 },
    );
    assert.equal(b.score, 100);
  });

  it("stale one-way contact scores 8", () => {
    const b = computeWarmth(
      { lastTouchAt: daysAgo(400), touchCount: 1, inboundCount: 0, outboundCount: 1 },
      NOW,
    );
    assert.deepEqual(
      { recency: b.recency, frequency: b.frequency, reciprocity: b.reciprocity },
      { recency: 0, frequency: 8, reciprocity: 0 },
    );
    assert.equal(b.score, 8);
  });

  it("mid-warmth contact scores 63", () => {
    const b = computeWarmth(
      { lastTouchAt: daysAgo(20), touchCount: 4, inboundCount: 1, outboundCount: 3 },
      NOW,
    );
    // 20d → 35 recency; 4 touches → 20 frequency; 1/4 inbound → 8 reciprocity.
    assert.equal(b.score, 63);
  });

  it("never-touched contact scores 0", () => {
    const b = computeWarmth(
      { lastTouchAt: null, touchCount: 0, inboundCount: 0, outboundCount: 0 },
      NOW,
    );
    assert.equal(b.score, 0);
  });

  it("recency band boundaries are exact", () => {
    const base = { touchCount: 1, inboundCount: 1, outboundCount: 0 };
    assert.equal(computeWarmth({ ...base, lastTouchAt: daysAgo(7) }, NOW).recency, 50);
    assert.equal(computeWarmth({ ...base, lastTouchAt: daysAgo(8) }, NOW).recency, 35);
    assert.equal(computeWarmth({ ...base, lastTouchAt: daysAgo(90) }, NOW).recency, 20);
    assert.equal(computeWarmth({ ...base, lastTouchAt: daysAgo(180) }, NOW).recency, 10);
    assert.equal(computeWarmth({ ...base, lastTouchAt: daysAgo(365) }, NOW).recency, 5);
    assert.equal(computeWarmth({ ...base, lastTouchAt: daysAgo(366) }, NOW).recency, 0);
  });

  it("frequency bands are exact", () => {
    const at = daysAgo(3);
    const freq = (n: number) =>
      computeWarmth({ lastTouchAt: at, touchCount: n, inboundCount: n, outboundCount: 0 }, NOW)
        .frequency;
    assert.equal(freq(0), 0);
    assert.equal(freq(1), 8);
    assert.equal(freq(2), 14);
    assert.equal(freq(4), 20);
    assert.equal(freq(9), 26);
    assert.equal(freq(10), 30);
    assert.equal(freq(50), 30);
  });

  it("reciprocity bands are exact", () => {
    const at = daysAgo(3);
    const recip = (inb: number, total: number) =>
      computeWarmth({ lastTouchAt: at, touchCount: total, inboundCount: inb, outboundCount: total - inb }, NOW)
        .reciprocity;
    assert.equal(recip(0, 4), 0);
    assert.equal(recip(1, 6), 4); // ~17% → 4
    assert.equal(recip(1, 5), 8); // 20% → 8
    assert.equal(recip(1, 4), 8); // 25% → 8
    assert.equal(recip(1, 3), 14); // 33.3% → 14
    assert.equal(recip(1, 2), 20); // 50% → 20
    assert.equal(recip(0, 0), 0);
  });

  it("is deterministic and clamps at 100", () => {
    const s = { lastTouchAt: daysAgo(1), touchCount: 99, inboundCount: 99, outboundCount: 0 };
    assert.deepEqual(computeWarmth(s, NOW), computeWarmth(s, NOW));
    assert.ok(computeWarmth(s, NOW).score <= 100);
  });

  it("band tables match the documented weights", () => {
    assert.equal(Math.max(...WARMTH_RECENCY_BANDS.map((b) => b[1])), WARMTH_WEIGHTS.recency);
    assert.equal(Math.max(...WARMTH_FREQUENCY_BANDS.map((b) => b[1])), WARMTH_WEIGHTS.frequency);
    assert.equal(Math.max(...WARMTH_RECIPROCITY_BANDS.map((b) => b[1])), WARMTH_WEIGHTS.reciprocity);
  });
});

// ---------------------------------------------------------------------------
// Validation — pure.
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("person requires name and consentedBy (provenance)", () => {
    assert.ok(validatePersonInput({ consentedBy: "me" }).errors.length > 0);
    assert.ok(validatePersonInput({ name: "Ada" }).errors.length > 0);
    const good = validatePersonInput({
      name: " Ada Lovelace ",
      roles: ["Angel"],
      handles: ["ada@example.com"],
      consentedBy: "founder@example.com",
    });
    assert.equal(good.errors.length, 0);
    assert.ok(good.value);
    assert.equal(good.value.name, "Ada Lovelace");
    assert.equal(good.value.consentedBy, "founder@example.com");
    assert.ok(good.value.consentedAt instanceof Date);
  });

  it("company rejects unknown enums", () => {
    assert.ok(validateCompanyInput({ name: "Acme", sizeBand: "huge" }).errors.length > 0);
    assert.ok(validateCompanyInput({ name: "Acme", relationship: "enemy" }).errors.length > 0);
    const good = validateCompanyInput({
      name: "Acme",
      sizeBand: "startup",
      relationship: "prospect",
    });
    assert.equal(good.errors.length, 0);
  });

  it("import batch requires consentedBy — no consent, no batch", () => {
    assert.ok(validateImportBatchInput({ source: "csv" }).errors.length > 0);
    assert.ok(validateImportBatchInput({ source: "carrier-pigeon" }).errors.length > 0);
    const good = validateImportBatchInput({
      source: "email",
      consentedBy: "founder@example.com",
      note: "gmail import",
    });
    assert.equal(good.errors.length, 0);
    assert.ok(good.value);
    assert.equal(good.value.source, "email");
  });

  it("touch requires a direction", () => {
    assert.ok(validateTouchInput({ personId: "x" }).errors.length > 0);
    assert.ok(
      validateTouchInput({ personId: "x", direction: "telepathy" }).errors.length > 0,
    );
    const good = validateTouchInput({ personId: "x", direction: "inbound" });
    assert.equal(good.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// DB: provenance, lifecycle, warmth sweep.
// ---------------------------------------------------------------------------

describe("provenance", () => {
  it("every person records importBatchId + consentedBy + consentedAt", async () => {
    const ws = await makeWorkspace();
    const batch = await store.createImportBatch(ws, {
      source: "csv",
      consentedBy: "founder@example.com",
      note: "Q3 network export",
    });
    assert.equal(batch.source, "csv");
    assert.equal(batch.consentedBy, "founder@example.com");
    assert.equal(batch.personCount, 0);

    const person = await store.addPerson(ws, {
      name: "Dana",
      roles: ["Partner"],
      importBatchId: batch.id,
      consentedBy: "founder@example.com",
      consentedAt: "2026-09-15T10:00:00Z",
    });
    assert.equal(person.importBatchId, batch.id);
    assert.equal(person.consentedBy, "founder@example.com");
    assert.equal(person.importBatch?.source, "csv");
    assert.equal(person.importBatch?.consentedBy, "founder@example.com");

    const batches = await store.listImportBatches(ws);
    assert.equal(batches.find((b) => b.id === batch.id)?.personCount, 1);
  });

  it("manual adds carry the founder as consenter with a default batch of none", async () => {
    const ws = await makeWorkspace();
    const person = await store.addPerson(ws, {
      name: "Eli",
      consentedBy: "founder@example.com",
    });
    assert.equal(person.importBatchId, null);
    assert.equal(person.importBatch, null);
    assert.equal(person.consentedBy, "founder@example.com");
    assert.ok(person.consentedAt instanceof Date);
  });

  it("a batch from another workspace cannot provenance a person", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const batchB = await store.createImportBatch(wsB, {
      source: "email",
      consentedBy: "founder@example.com",
    });
    const code = await codeOf(
      store.addPerson(wsA, {
        name: "Mallory",
        importBatchId: batchB.id,
        consentedBy: "founder@example.com",
      }),
    );
    assert.equal(code, "batch_not_found");
  });
});

describe("graph lifecycle", () => {
  it("company dedups per tenant, employment links both nodes", async () => {
    const ws = await makeWorkspace();
    const co = await store.addCompany(ws, {
      name: "Acme",
      industry: "HVAC",
      sizeBand: "smb",
      relationship: "prospect",
    });
    assert.equal(co.relationship, "prospect");
    assert.equal(await codeOf(store.addCompany(ws, { name: "Acme" })), "duplicate_company");

    const person = await store.addPerson(ws, { name: "Dana", consentedBy: "me" });
    const emp = await store.linkEmployment(ws, {
      personId: person.id,
      companyId: co.id,
      title: "VP Sales",
      isCurrent: true,
    });
    assert.equal(emp.companyName, "Acme");
    assert.equal(
      await codeOf(
        store.linkEmployment(ws, { personId: person.id, companyId: co.id }),
      ),
      "duplicate_employment",
    );

    const detail = await store.getPersonDetail(ws, person.id);
    assert.equal(detail?.employments.length, 1);
    assert.equal(detail?.employments[0].companyName, "Acme");
  });

  it("recordTouch creates the edge, accumulates signals, recomputes warmth", async () => {
    const ws = await makeWorkspace();
    const person = await store.addPerson(ws, { name: "Dana", consentedBy: "me" });

    // No relationship yet.
    const before = await store.getPersonDetail(ws, person.id);
    assert.equal(before?.relationship, null);

    const r1 = await store.recordTouchValue(ws, person.id, "outbound", daysAgo(2), NOW);
    assert.equal(r1.touchCount, 1);
    assert.equal(r1.outboundCount, 1);
    assert.equal(r1.inboundCount, 0);
    // 2d → 50 recency; 1 touch → 8 frequency; 0 inbound → 0 reciprocity.
    assert.equal(r1.warmthScore, 58);

    const r2 = await store.recordTouchValue(ws, person.id, "inbound", daysAgo(1), NOW);
    assert.equal(r2.touchCount, 2);
    assert.equal(r2.inboundCount, 1);
    assert.ok(r2.lastReciprocalTouchAt instanceof Date);
    // 1d → 50; 2 touches → 14; 1/2 inbound → 20.
    assert.equal(r2.warmthScore, 84);
  });

  it("updateRelationship writes notes/boundaries but never warmth", async () => {
    const ws = await makeWorkspace();
    const person = await store.addPerson(ws, { name: "Dana", consentedBy: "me" });
    await store.recordTouchValue(ws, person.id, "inbound", daysAgo(1), NOW);

    // Pass the test clock: without it warmth is scored against the real date
    // and the fixed 1-day-old touch decays as the calendar moves on.
    const updated = await store.updateRelationship(
      ws,
      person.id,
      {
        notes: "Met at Raleigh Founded.",
        boundaries: "don't ask for intros more than quarterly",
      },
      NOW,
    );
    assert.equal(updated.notes, "Met at Raleigh Founded.");
    assert.equal(updated.boundaries, "don't ask for intros more than quarterly");
    // Warmth recomputed from signals, untouched by the patch:
    // 1d → 50 recency; 1 touch → 8 frequency; 1/1 inbound → 20 reciprocity.
    assert.equal(updated.warmthScore, 78);
    assert.equal(updated.warmthBreakdown.score, 78);
  });

  it("recomputeAllWarmth refreshes stale scores from signals", async () => {
    const ws = await makeWorkspace();
    const person = await store.addPerson(ws, { name: "Dana", consentedBy: "me" });
    await store.recordTouchValue(ws, person.id, "inbound", daysAgo(1), NOW);

    // Simulate a stale/hand-set score: signals say 1 touch 400d ago.
    await prisma.connectorRelationship.update({
      where: { personId: person.id },
      data: {
        lastTouchAt: daysAgo(400),
        touchCount: 1,
        inboundCount: 0,
        outboundCount: 1,
        warmthScore: 999,
      },
    });

    const result = await store.recomputeAllWarmth(ws, NOW);
    assert.equal(result.recomputed, 1);
    assert.equal(result.scores[0]?.personId, person.id);
    // 400d → 0; 1 touch → 8; 0 inbound → 0.
    assert.equal(result.scores[0]?.score, 8);

    const detail = await store.getPersonDetail(ws, person.id);
    assert.equal(detail?.relationship?.warmthScore, 8);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation — PROVEN: two workspaces' graphs, every query path.
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  async function seedGraph(ws: string, tag: string) {
    const batch = await store.createImportBatch(ws, {
      source: "csv",
      consentedBy: `${tag}@example.com`,
    });
    const p1 = await store.addPerson(ws, {
      name: `${tag} Person One`,
      importBatchId: batch.id,
      consentedBy: `${tag}@example.com`,
    });
    const p2 = await store.addPerson(ws, {
      name: `${tag} Person Two`,
      consentedBy: `${tag}@example.com`,
    });
    const co = await store.addCompany(ws, { name: `${tag} Co`, relationship: "customer" });
    await store.linkEmployment(ws, { personId: p1.id, companyId: co.id, title: "CEO" });
    await store.recordTouchValue(ws, p1.id, "inbound", daysAgo(2), NOW);
    // Ensure p2 has a relationship row, then set its boundary.
    await store.ensureRelationship(ws, p2.id, NOW);
    await store.updateRelationship(ws, p2.id, { boundaries: `${tag} boundary` });
    return { batch, p1, p2, co };
  }

  it("list paths return only the caller's tenant data", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const a = await seedGraph(wsA, "aaa");
    const b = await seedGraph(wsB, "bbb");

    const personsA = await store.listPersons(wsA, NOW);
    assert.equal(personsA.length, 2);
    assert.deepEqual(
      personsA.map((p) => p.id).sort(),
      [a.p1.id, a.p2.id].sort(),
    );
    assert.ok(personsA.every((p) => p.name.startsWith("aaa")));

    const companiesA = await store.listCompanies(wsA);
    assert.equal(companiesA.length, 1);
    assert.equal(companiesA[0]?.id, a.co.id);

    const batchesA = await store.listImportBatches(wsA);
    assert.equal(batchesA.length, 1);
    assert.equal(batchesA[0]?.id, a.batch.id);

    const graphB = await store.listGraph(wsB, NOW);
    assert.equal(graphB.persons.length, 2);
    assert.ok(graphB.persons.every((p) => p.name.startsWith("bbb")));
    assert.equal(graphB.companies[0]?.id, b.co.id);
    assert.equal(graphB.batches[0]?.id, b.batch.id);

    // No id from B appears anywhere in A's reads.
    const bIds = new Set([b.p1.id, b.p2.id, b.co.id, b.batch.id]);
    const seenInA = [
      ...personsA.map((p) => p.id),
      ...companiesA.map((c) => c.id),
      ...batchesA.map((b2) => b2.id),
    ];
    assert.ok(seenInA.every((id) => !bIds.has(id)));
  });

  it("detail read by id is tenant-scoped (no cross-tenant read)", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const b = await seedGraph(wsB, "bbb");
    await seedGraph(wsA, "aaa");

    assert.equal(await store.getPersonDetail(wsA, b.p1.id, NOW), null);
  });

  it("every mutation path rejects other-tenant ids", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const a = await seedGraph(wsA, "aaa");
    const b = await seedGraph(wsB, "bbb");

    assert.equal(await codeOf(store.recordTouchValue(wsA, b.p1.id, "inbound", NOW, NOW)), "person_not_found");
    assert.equal(await codeOf(store.ensureRelationship(wsA, b.p1.id, NOW)), "person_not_found");
    assert.equal(
      await codeOf(store.updateRelationship(wsA, b.p1.id, { notes: "x" }, NOW)),
      "person_not_found",
    );
    assert.equal(
      await codeOf(
        store.linkEmployment(wsA, { personId: b.p1.id, companyId: a.co.id }),
      ),
      "person_not_found",
    );
    assert.equal(
      await codeOf(
        store.linkEmployment(wsA, { personId: a.p1.id, companyId: b.co.id }),
      ),
      "company_not_found",
    );
    assert.equal(
      await codeOf(
        store.addPerson(wsA, { name: "X", importBatchId: b.batch.id, consentedBy: "me" }),
      ),
      "batch_not_found",
    );
  });

  it("company name uniqueness is per-tenant, not global", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    await store.addCompany(wsA, { name: "Acme" });
    const coB = await store.addCompany(wsB, { name: "Acme" });
    assert.equal(coB.name, "Acme");
    assert.equal((await store.listCompanies(wsA)).length, 1);
    assert.equal((await store.listCompanies(wsB)).length, 1);
  });

  it("the warmth sweep never touches another tenant's rows", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const a = await seedGraph(wsA, "aaa");
    const b = await seedGraph(wsB, "bbb");

    // Plant a stale score on B's relationship.
    await prisma.connectorRelationship.update({
      where: { personId: b.p1.id },
      data: { warmthScore: 777 },
    });

    const result = await store.recomputeAllWarmth(wsA, NOW);
    assert.ok(result.scores.every((s) => [a.p1.id, a.p2.id].includes(s.personId)));

    const bRel = await prisma.connectorRelationship.findUnique({
      where: { personId: b.p1.id },
    });
    assert.equal(bRel?.warmthScore, 777);
  });
});
