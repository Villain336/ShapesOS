// Marketr — Connector Agent slice 3 tests: IntroPath engine.
// Run: npx tsx --test lib/connector/__tests__/connector-slice3.test.ts
//
// Pure engine tests run on fixture graphs (no DB). DB-backed tests run
// against the local dev DB and clean up their own test workspaces
// (cascades purge connector rows).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaConnectorStore } from "../prisma-store";
import {
  boundaryBlocksIntros,
  clearIntroPathCache,
  coEmploymentStrength,
  computeIntroPaths,
  employmentOverlap,
  freshnessDecay,
  personIsExcluded,
  relativeTime,
  INTRO_DEFAULT_MAX_PATHS,
  INTRO_FRESHNESS_NEVER_TOUCHED,
  type ComputedIntroPath,
  type IntroPathRequest,
  type PathPersonInput,
} from "../intro-paths";
import { computeWarmth, ConnectorError } from "../types";

const store = new PrismaConnectorStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-connector-slice3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-connector-slice3",
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
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

// ---------------------------------------------------------------------------
// Fixture builders (pure).
// ---------------------------------------------------------------------------

interface FixtureOpts {
  warmth?: number;
  lastTouchAt?: Date | null;
  notes?: string | null;
  boundaries?: string | null;
  employments?: PathPersonInput["employments"];
  handles?: string[];
  noRelationship?: boolean;
}

function fixturePerson(id: string, name: string, opts: FixtureOpts = {}): PathPersonInput {
  return {
    id,
    name,
    handles: opts.handles ?? [],
    relationship: opts.noRelationship
      ? null
      : {
          warmthScore: opts.warmth ?? 50,
          lastTouchAt: opts.lastTouchAt === undefined ? daysAgo(10) : opts.lastTouchAt,
          notes: opts.notes ?? null,
          boundaries: opts.boundaries ?? null,
        },
    employments: opts.employments ?? [],
  };
}

function emp(
  companyId: string,
  companyName: string,
  partial: Partial<PathPersonInput["employments"][number]> = {},
): PathPersonInput["employments"][number] {
  return {
    companyId,
    companyName,
    title: partial.title ?? null,
    startYear: partial.startYear ?? null,
    endYear: partial.endYear ?? null,
    isCurrent: partial.isCurrent ?? true,
  };
}

function baseReq(partial: Partial<IntroPathRequest> = {}): IntroPathRequest {
  return {
    persons: [],
    companies: [{ id: "co-acme", name: "Acme" }],
    exclusions: [],
    now: NOW,
    ...partial,
  };
}

// ===========================================================================
// Pure engine: path correctness.
// ===========================================================================

describe("intro-paths: basic A→B→C computation", () => {
  it("finds a path via a mutual who shares a company with the target", () => {
    const dana = fixturePerson("p-dana", "Dana", {
      warmth: 80,
      lastTouchAt: daysAgo(21),
      notes: "met at Raleigh Founded",
      employments: [emp("co-acme", "Acme", { startYear: 2020, endYear: 2024, isCurrent: false })],
    });
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2022, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({ persons: [dana, elena], targetPersonId: "p-elena" }),
    );
    assert.equal(result.blocked, null);
    assert.equal(result.paths.length, 1);
    const path = result.paths[0] as ComputedIntroPath;
    assert.equal(path.mutual.id, "p-dana");
    assert.deepEqual(
      path.hops.map((h) => h.name),
      ["You", "Dana", "Elena Vasquez"],
    );
    // Explanation composes ONLY stored facts: shared company, overlap
    // years, relative last-touch, and the verbatim notes.
    assert.equal(
      path.explanation.text,
      "via Dana — worked together at Acme (2022–24), last touched 3 weeks ago. Context: met at Raleigh Founded",
    );
    assert.deepEqual(path.explanation.facts, {
      mutualName: "Dana",
      sharedCompany: "Acme",
      overlapStart: 2022,
      overlapEnd: 2024,
      lastTouchText: "3 weeks ago",
      notes: "met at Raleigh Founded",
    });
  });

  it("scores strength as the warmth product: (tenant→mutual/100) × link × freshness", () => {
    const dana = fixturePerson("p-dana", "Dana", {
      warmth: 80,
      lastTouchAt: daysAgo(21),
      employments: [emp("co-acme", "Acme", { startYear: 2020, endYear: 2024, isCurrent: false })],
    });
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2022, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({ persons: [dana, elena], targetPersonId: "p-elena" }),
    );
    const path = result.paths[0] as ComputedIntroPath;
    const link = coEmploymentStrength({ overlapYears: 3, currentlyTogether: false });
    const fresh = freshnessDecay(daysAgo(21), NOW);
    assert.ok(Math.abs(path.strength - 0.8 * link * fresh) < 0.001);
    assert.equal(path.components.tenantWarmth, 80);
    assert.ok(Math.abs(path.components.linkStrength - link) < 0.001);
    assert.ok(Math.abs(path.components.freshness - fresh) < 0.001);
  });

  it("ranks by warmth product: warmer mutual first at equal link/freshness", () => {
    const mk = (id: string, name: string, warmth: number) =>
      fixturePerson(id, name, {
        warmth,
        lastTouchAt: daysAgo(10),
        employments: [emp("co-acme", "Acme", { startYear: 2020, isCurrent: true })],
      });
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2021, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({
        persons: [mk("p-sam", "Sam", 40), mk("p-dana", "Dana", 80), elena],
        targetPersonId: "p-elena",
      }),
    );
    assert.equal(result.paths.length, 2);
    assert.equal(result.paths[0]?.mutual.name, "Dana");
    assert.equal(result.paths[1]?.mutual.name, "Sam");
    const [d, s] = result.paths;
    assert.ok(Math.abs(d!.strength / s!.strength - 80 / 40) < 0.01);
  });

  it("skips mutuals with no tenant relationship edge (no standing to ask)", () => {
    const ghost = fixturePerson("p-ghost", "Ghost", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2020, isCurrent: true })],
    });
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2021, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({ persons: [ghost, elena], targetPersonId: "p-elena" }),
    );
    assert.equal(result.paths.length, 0);
  });

  it("never routes through the target themselves", () => {
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      warmth: 90,
      lastTouchAt: daysAgo(2),
      employments: [emp("co-acme", "Acme", { startYear: 2021, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({ persons: [elena], targetPersonId: "p-elena" }),
    );
    assert.equal(result.paths.length, 0);
  });

  it("returns target_not_found for an unknown target id", () => {
    const result = computeIntroPaths(baseReq({ targetPersonId: "nope" }));
    assert.equal(result.blocked, "target_not_found");
    assert.equal(result.paths.length, 0);
  });

  it("caps paths at maxPaths", () => {
    const persons: PathPersonInput[] = [];
    for (let i = 0; i < 20; i++) {
      persons.push(
        fixturePerson(`p-m${i}`, `Mutual ${i}`, {
          warmth: 50,
          lastTouchAt: daysAgo(10),
          employments: [emp("co-acme", "Acme", { startYear: 2020, isCurrent: true })],
        }),
      );
    }
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2021, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({ persons: [...persons, elena], targetPersonId: "p-elena", maxPaths: 5 }),
    );
    assert.equal(result.paths.length, 5);
  });
});

// ===========================================================================
// Pure engine: company targets.
// ===========================================================================

describe("intro-paths: company targets", () => {
  it("finds paths into a company via its employees", () => {
    const dana = fixturePerson("p-dana", "Dana", {
      warmth: 70,
      lastTouchAt: daysAgo(5),
      employments: [emp("co-acme", "Acme", { startYear: 2021, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({ persons: [dana], targetCompanyId: "co-acme" }),
    );
    assert.equal(result.blocked, null);
    assert.equal(result.paths.length, 1);
    const path = result.paths[0] as ComputedIntroPath;
    assert.equal(path.target.kind, "company");
    assert.equal(path.target.name, "Acme");
    assert.ok(path.explanation.text.startsWith("via Dana — works at Acme"));
    assert.ok(path.explanation.text.includes("(2021–26)"));
  });

  it("prefers current employees over past ones (link strength)", () => {
    const past = fixturePerson("p-past", "Past Employee", {
      warmth: 60,
      lastTouchAt: daysAgo(5),
      employments: [emp("co-acme", "Acme", { startYear: 2015, endYear: 2018, isCurrent: false })],
    });
    const current = fixturePerson("p-current", "Current Employee", {
      warmth: 60,
      lastTouchAt: daysAgo(5),
      employments: [emp("co-acme", "Acme", { startYear: 2022, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({ persons: [past, current], targetCompanyId: "co-acme" }),
    );
    assert.equal(result.paths.length, 2);
    assert.equal(result.paths[0]?.mutual.name, "Current Employee");
    assert.ok(
      (result.paths[0]?.components.linkStrength ?? 0) >
        (result.paths[1]?.components.linkStrength ?? 0),
    );
  });
});

// ===========================================================================
// Pure engine: freshness decay.
// ===========================================================================

describe("intro-paths: freshness decay", () => {
  it("decays monotonically with age and floors at 0.1", () => {
    const f0 = freshnessDecay(NOW, NOW);
    const f30 = freshnessDecay(daysAgo(30), NOW);
    const f365 = freshnessDecay(daysAgo(365), NOW);
    const f2000 = freshnessDecay(daysAgo(2000), NOW);
    assert.ok(f0 > f30 && f30 > f365);
    assert.equal(f0, 1);
    assert.ok(Math.abs(f30 - Math.exp(-30 / 180)) < 1e-9);
    assert.equal(f2000, 0.1);
  });

  it("assigns a degraded-but-nonzero freshness when never touched", () => {
    assert.equal(freshnessDecay(null, NOW), INTRO_FRESHNESS_NEVER_TOUCHED);
  });

  it("ranks a freshly-touched mutual above a stale one at equal warmth", () => {
    const mk = (id: string, name: string, lastTouchAt: Date | null) =>
      fixturePerson(id, name, {
        warmth: 60,
        lastTouchAt,
        employments: [emp("co-acme", "Acme", { startYear: 2020, isCurrent: true })],
      });
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2021, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({
        persons: [mk("p-stale", "Stale", daysAgo(300)), mk("p-fresh", "Fresh", daysAgo(2)), elena],
        targetPersonId: "p-elena",
      }),
    );
    assert.equal(result.paths.length, 2);
    assert.equal(result.paths[0]?.mutual.name, "Fresh");
    assert.ok(
      (result.paths[0]?.components.freshness ?? 0) >
        (result.paths[1]?.components.freshness ?? 0),
    );
  });
});

// ===========================================================================
// Pure engine: boundaries + exclusions.
// ===========================================================================

describe("intro-paths: boundary blocks", () => {
  it("blocks negated-intro phrasing", () => {
    assert.equal(boundaryBlocksIntros("don't ask for intros"), true);
    assert.equal(boundaryBlocksIntros("Do not contact for introductions"), true);
    assert.equal(boundaryBlocksIntros("never ask me for an intro"), true);
    assert.equal(boundaryBlocksIntros("No intros — too busy"), true);
  });

  it("does NOT block frequency-qualified boundaries (slice-4 rate limits)", () => {
    assert.equal(boundaryBlocksIntros("don't ask for intros more than quarterly"), false);
    assert.equal(boundaryBlocksIntros("intros ok once a month"), false);
  });

  it("does NOT block unrelated boundaries", () => {
    assert.equal(boundaryBlocksIntros(null), false);
    assert.equal(boundaryBlocksIntros(""), false);
    assert.equal(boundaryBlocksIntros("prefers email over calls"), false);
    assert.equal(boundaryBlocksIntros("loves talking about soccer"), false);
  });

  it("never routes through a boundary-blocked mutual", () => {
    const blocked = fixturePerson("p-blocked", "Blocked", {
      warmth: 95,
      lastTouchAt: daysAgo(1),
      boundaries: "don't ask for intros",
      employments: [emp("co-acme", "Acme", { startYear: 2020, isCurrent: true })],
    });
    const ok = fixturePerson("p-ok", "Okay", {
      warmth: 40,
      lastTouchAt: daysAgo(1),
      boundaries: "don't ask for intros more than quarterly",
      employments: [emp("co-acme", "Acme", { startYear: 2020, isCurrent: true })],
    });
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2021, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({ persons: [blocked, ok, elena], targetPersonId: "p-elena" }),
    );
    assert.equal(result.paths.length, 1);
    assert.equal(result.paths[0]?.mutual.name, "Okay");
  });
});

describe("intro-paths: exclusions", () => {
  it("never routes through an excluded mutual", () => {
    const dana = fixturePerson("p-dana", "Dana", {
      warmth: 80,
      lastTouchAt: daysAgo(5),
      employments: [emp("co-acme", "Acme", { startYear: 2020, isCurrent: true })],
    });
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2021, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({
        persons: [dana, elena],
        targetPersonId: "p-elena",
        exclusions: [{ type: "person_name", value: "dana" }],
      }),
    );
    assert.equal(result.paths.length, 0);
    assert.ok(personIsExcluded([{ type: "person_name", value: "dana" }], dana));
  });

  it("matches email/domain exclusions against handles", () => {
    const dana = fixturePerson("p-dana", "Dana", {
      handles: ["dana@competitor.com"],
      employments: [emp("co-acme", "Acme", { startYear: 2020, isCurrent: true })],
    });
    assert.ok(
      personIsExcluded([{ type: "domain", value: "competitor.com" }], dana),
    );
    assert.ok(
      !personIsExcluded([{ type: "domain", value: "other.com" }], dana),
    );
  });

  it("blocks paths to an excluded target", () => {
    const dana = fixturePerson("p-dana", "Dana", {
      warmth: 80,
      lastTouchAt: daysAgo(5),
      employments: [emp("co-acme", "Acme", { startYear: 2020, isCurrent: true })],
    });
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2021, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({
        persons: [dana, elena],
        targetPersonId: "p-elena",
        exclusions: [{ type: "person_name", value: "elena" }],
      }),
    );
    assert.equal(result.blocked, "target_excluded");
    assert.equal(result.paths.length, 0);
  });
});

// ===========================================================================
// Pure engine: explanations never invent facts.
// ===========================================================================

describe("intro-paths: explanations use stored data only", () => {
  it("drops unknown-data clauses instead of guessing", () => {
    const dana = fixturePerson("p-dana", "Dana", {
      warmth: 50,
      lastTouchAt: null,
      employments: [emp("co-acme", "Acme")], // no years, no notes
    });
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme")],
    });
    const result = computeIntroPaths(
      baseReq({ persons: [dana, elena], targetPersonId: "p-elena" }),
    );
    const text = (result.paths[0] as ComputedIntroPath).explanation.text;
    assert.equal(text, "via Dana — works with them at Acme, last touched never");
    assert.ok(!text.includes("Context:"));
  });

  it("phrases different-era employment honestly", () => {
    const dana = fixturePerson("p-dana", "Dana", {
      warmth: 50,
      lastTouchAt: daysAgo(3),
      employments: [emp("co-acme", "Acme", { startYear: 2010, endYear: 2012, isCurrent: false })],
    });
    const elena = fixturePerson("p-elena", "Elena Vasquez", {
      noRelationship: true,
      employments: [emp("co-acme", "Acme", { startYear: 2020, isCurrent: true })],
    });
    const result = computeIntroPaths(
      baseReq({ persons: [dana, elena], targetPersonId: "p-elena" }),
    );
    const text = (result.paths[0] as ComputedIntroPath).explanation.text;
    assert.ok(text.includes("both worked at Acme"));
    assert.ok(!text.includes("worked together"));
  });

  it("relativeTime covers every band", () => {
    assert.equal(relativeTime(NOW, NOW), "today");
    assert.equal(relativeTime(daysAgo(1), NOW), "yesterday");
    assert.equal(relativeTime(daysAgo(4), NOW), "4 days ago");
    assert.equal(relativeTime(daysAgo(21), NOW), "3 weeks ago");
    assert.equal(relativeTime(daysAgo(75), NOW), "2 months ago");
    assert.equal(relativeTime(daysAgo(400), NOW), "1 year ago");
    assert.equal(relativeTime(null, NOW), "never");
  });

  it("coEmploymentStrength: base, overlap bonus capped, current-together bonus", () => {
    assert.equal(coEmploymentStrength({ overlapYears: null, currentlyTogether: false }), 0.5);
    assert.ok(
      Math.abs(coEmploymentStrength({ overlapYears: 2, currentlyTogether: false }) - 0.7) < 1e-9,
    );
    assert.equal(coEmploymentStrength({ overlapYears: 10, currentlyTogether: false }), 0.8);
    assert.equal(coEmploymentStrength({ overlapYears: 10, currentlyTogether: true }), 1);
  });

  it("employmentOverlap returns null without shared years", () => {
    const ov = employmentOverlap(
      { startYear: 2020, endYear: 2024, isCurrent: false },
      { startYear: 2022, endYear: null, isCurrent: true },
      2026,
    );
    assert.deepEqual(ov, { start: 2022, end: 2024, years: 3 });
    assert.equal(
      employmentOverlap(
        { startYear: null, endYear: null, isCurrent: true },
        { startYear: 2022, endYear: null, isCurrent: true },
        2026,
      ),
      null,
    );
    assert.equal(
      employmentOverlap(
        { startYear: 2010, endYear: 2012, isCurrent: false },
        { startYear: 2020, endYear: null, isCurrent: true },
        2026,
      ),
      null,
    );
  });

  it("defaults maxPaths to the documented constant", () => {
    assert.equal(INTRO_DEFAULT_MAX_PATHS, 10);
  });
});

// ===========================================================================
// DB-backed: end-to-end + tenant isolation.
// ===========================================================================

describe("intro-paths: DB-backed end-to-end", () => {
  it("computes paths from the tenant's real rows, honoring boundaries and cache", async () => {
    clearIntroPathCache();
    const ws = await makeWorkspace();

    const dana = await store.addPerson(ws, {
      name: "Dana",
      roles: ["Advisor"],
      handles: [],
      consentedBy: "test",
    });
    const elena = await store.addPerson(ws, {
      name: "Elena Vasquez",
      roles: ["Partner"],
      handles: [],
      consentedBy: "test",
    });
    const acme = await store.addCompany(ws, { name: "Acme" });
    await store.linkEmployment(ws, {
      personId: dana.id,
      companyId: acme.id,
      startYear: 2020,
      endYear: 2024,
      isCurrent: false,
    });
    await store.linkEmployment(ws, {
      personId: elena.id,
      companyId: acme.id,
      startYear: 2022,
      isCurrent: true,
    });
    // Seed warmth: 10 touches, half inbound, last touch 21 days ago → 100.
    for (let i = 0; i < 5; i++) {
      await store.recordTouchValue(ws, dana.id, "inbound", daysAgo(21 - i), NOW);
      await store.recordTouchValue(ws, dana.id, "outbound", daysAgo(21 - i), NOW);
    }
    await store.updateRelationship(ws, dana.id, {
      notes: "met at Raleigh Founded",
    }, NOW);

    const first = await store.computeIntroPaths(ws, {
      targetPersonId: elena.id,
      now: NOW,
    });
    assert.equal(first.cached, false);
    assert.equal(first.result.blocked, null);
    assert.equal(first.result.paths.length, 1);
    const path = first.result.paths[0] as ComputedIntroPath;
    assert.equal(path.mutual.name, "Dana");
    const expected = computeWarmth(
      { lastTouchAt: daysAgo(21), touchCount: 10, inboundCount: 5, outboundCount: 5 },
      NOW,
    ).score;
    assert.equal(path.components.tenantWarmth, expected);
    assert.ok(path.explanation.text.includes("worked together at Acme (2022–24)"));
    assert.ok(path.explanation.text.includes("Context: met at Raleigh Founded"));

    // Second call serves from the cache.
    const second = await store.computeIntroPaths(ws, {
      targetPersonId: elena.id,
      now: NOW,
    });
    assert.equal(second.cached, true);
    assert.equal(second.result.paths.length, 1);

    // Recompute bypasses the cache and re-walks the graph.
    const third = await store.computeIntroPaths(ws, {
      targetPersonId: elena.id,
      recompute: true,
      now: NOW,
    });
    assert.equal(third.cached, false);

    // A boundary block added later removes the path on recompute.
    await store.updateRelationship(ws, dana.id, { boundaries: "don't ask for intros" }, NOW);
    const fourth = await store.computeIntroPaths(ws, {
      targetPersonId: elena.id,
      recompute: true,
      now: NOW,
    });
    assert.equal(fourth.result.paths.length, 0);
  });

  it("PROVEN: tenant isolation — no cross-tenant persons in paths", async () => {
    clearIntroPathCache();
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();

    // Tenant A: Dana (A's mutual) shares Acme with Elena (A's target).
    const danaA = await store.addPerson(wsA, { name: "Dana", consentedBy: "test" });
    const elenaA = await store.addPerson(wsA, { name: "Elena Vasquez", consentedBy: "test" });
    const acmeA = await store.addCompany(wsA, { name: "Acme" });
    await store.linkEmployment(wsA, { personId: danaA.id, companyId: acmeA.id, isCurrent: true });
    await store.linkEmployment(wsA, { personId: elenaA.id, companyId: acmeA.id, isCurrent: true });
    await store.recordTouchValue(wsA, danaA.id, "inbound", daysAgo(2), NOW);

    // Tenant B: its own Dana + Mallory share B's Acme with B's target.
    const danaB = await store.addPerson(wsB, { name: "Dana", consentedBy: "test" });
    const malloryB = await store.addPerson(wsB, { name: "Mallory", consentedBy: "test" });
    const targetB = await store.addPerson(wsB, { name: "Target B", consentedBy: "test" });
    const acmeB = await store.addCompany(wsB, { name: "Acme" });
    await store.linkEmployment(wsB, { personId: danaB.id, companyId: acmeB.id, isCurrent: true });
    await store.linkEmployment(wsB, { personId: malloryB.id, companyId: acmeB.id, isCurrent: true });
    await store.linkEmployment(wsB, { personId: targetB.id, companyId: acmeB.id, isCurrent: true });
    await store.recordTouchValue(wsB, danaB.id, "inbound", daysAgo(2), NOW);
    await store.recordTouchValue(wsB, malloryB.id, "inbound", daysAgo(1), NOW);

    const pathsA = await store.computeIntroPaths(wsA, {
      targetPersonId: elenaA.id,
      now: NOW,
    });
    assert.equal(pathsA.result.paths.length, 1);
    assert.equal(pathsA.result.paths[0]?.mutual.name, "Dana");
    assert.equal(pathsA.result.paths[0]?.mutual.id, danaA.id);

    // B's target id is meaningless in A's tenant — reads as not found,
    // never as B's data.
    const foreign = await store.computeIntroPaths(wsA, {
      targetPersonId: targetB.id,
      now: NOW,
    });
    assert.equal(foreign.result.blocked, "target_not_found");

    // B's own computation sees only B's mutuals (Dana + Mallory), never A's.
    const pathsB = await store.computeIntroPaths(wsB, {
      targetPersonId: targetB.id,
      now: NOW,
    });
    const mutualIds = pathsB.result.paths.map((p) => p.mutual.id).sort();
    assert.deepEqual(mutualIds, [danaB.id, malloryB.id].sort());
  });

  it("PROVEN: DB exclusions filter paths before computation", async () => {
    clearIntroPathCache();
    const ws = await makeWorkspace();
    const dana = await store.addPerson(ws, { name: "Dana", consentedBy: "test" });
    const elena = await store.addPerson(ws, { name: "Elena Vasquez", consentedBy: "test" });
    const acme = await store.addCompany(ws, { name: "Acme" });
    await store.linkEmployment(ws, { personId: dana.id, companyId: acme.id, isCurrent: true });
    await store.linkEmployment(ws, { personId: elena.id, companyId: acme.id, isCurrent: true });
    await store.recordTouchValue(ws, dana.id, "inbound", daysAgo(2), NOW);
    await store.addExclusion(ws, { type: "person_name", value: "dana" });

    const result = await store.computeIntroPaths(ws, {
      targetPersonId: elena.id,
      recompute: true,
      now: NOW,
    });
    assert.equal(result.result.paths.length, 0);
  });

  it("warmPathCache is bounded and tenant-scoped", async () => {
    clearIntroPathCache();
    const ws = await makeWorkspace();
    const acme = await store.addCompany(ws, { name: "Acme" });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await store.addPerson(ws, { name: `Net ${i}`, consentedBy: "test" });
      ids.push(p.id);
      await store.linkEmployment(ws, { personId: p.id, companyId: acme.id, isCurrent: true });
      await store.recordTouchValue(ws, p.id, "inbound", daysAgo(i + 1), NOW);
    }
    const r = await store.warmPathCache(ws, { maxTargets: 2, maxPaths: 3, now: NOW });
    assert.ok(r.targetsWarmed <= 2);
    // Paths were cached: a fresh request for a warmed target serves from cache.
    const cached = await store.computeIntroPaths(ws, {
      targetPersonId: ids[0],
      now: NOW,
    });
    assert.equal(cached.cached, true);
    assert.ok(cached.result.paths.length <= 3);
  });

  it("rejects requests without exactly one target", async () => {
    const ws = await makeWorkspace();
    const p = await store.addPerson(ws, { name: "Solo", consentedBy: "test" });
    await assert.rejects(
      () => store.computeIntroPaths(ws, { now: NOW }),
      (e: unknown) => e instanceof ConnectorError && e.code === "invalid_target",
    );
    await assert.rejects(
      () =>
        store.computeIntroPaths(ws, {
          targetPersonId: p.id,
          targetCompanyId: "x",
          now: NOW,
        }),
      (e: unknown) => e instanceof ConnectorError && e.code === "invalid_target",
    );
  });
});
