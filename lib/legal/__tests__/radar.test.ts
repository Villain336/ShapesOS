// Marketr — Legal/Compliance slice 4 tests: change-radar engine + seed guardrails.
// Run: npx tsx --test lib/legal/__tests__/radar.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  changeAppliesToProfile,
  changeToObligationSeed,
  triageChanges,
  validateSeedChanges,
} from "../radar";
import { validateSeedTemplates } from "../obligations";
import { REGULATION_CHANGE_SEEDS } from "../radar-seeds";
import {
  LEGAL_DISCLAIMER,
  SEED_FEED_NOTICE,
  type RadarTriageStatus,
  type SeedRegulationChange,
} from "../radar-types";
import { type LegalProfileInput } from "../types";

const foodNc: LegalProfileInput = {
  industry: "food",
  businessModel: "llc",
  jurisdictions: ["NC"],
};

const saasNational: LegalProfileInput = {
  industry: "saas",
  businessModel: "corporation",
  // Engine-level profile: national baseline only, no state layer.
  jurisdictions: [],
};

describe("changeAppliesToProfile", () => {
  it("applies national changes to every profile", () => {
    const c = { industries: [], jurisdictions: ["national"] };
    assert.equal(changeAppliesToProfile(c, foodNc), true);
    assert.equal(changeAppliesToProfile(c, saasNational), true);
  });

  it("applies jurisdiction-scoped changes only in matching jurisdictions", () => {
    const c = { industries: [], jurisdictions: ["NC"] };
    assert.equal(changeAppliesToProfile(c, foodNc), true);
    assert.equal(changeAppliesToProfile(c, saasNational), false);
  });

  it("filters by industry, with empty industries meaning all", () => {
    const foodOnly = { industries: ["food"], jurisdictions: ["national"] };
    assert.equal(changeAppliesToProfile(foodOnly, foodNc), true);
    assert.equal(changeAppliesToProfile(foodOnly, saasNational), false);
    const all = { industries: [], jurisdictions: ["national"] };
    assert.equal(changeAppliesToProfile(all, saasNational), true);
  });
});

describe("triageChanges", () => {
  const changes: SeedRegulationChange[] = [
    {
      key: "national-food",
      title: "National food change",
      plainEnglishSummary: "Applies to food everywhere.",
      industries: ["food"],
      jurisdictions: ["national"],
      category: "safety",
      effectiveDate: null,
      sourceRef: "FDA (verify before acting)",
      publishedAt: "2026-10-01T00:00:00.000Z",
      seedFlag: true,
    },
    {
      key: "nc-all",
      title: "NC change",
      plainEnglishSummary: "Applies to everyone in NC.",
      industries: [],
      jurisdictions: ["NC"],
      category: "tax",
      effectiveDate: null,
      sourceRef: "NC DOR (verify before acting)",
      publishedAt: "2026-09-20T00:00:00.000Z",
      seedFlag: true,
    },
    {
      key: "saas-only",
      title: "SaaS change",
      plainEnglishSummary: "Applies to SaaS only.",
      industries: ["saas"],
      jurisdictions: ["national"],
      category: "privacy",
      effectiveDate: null,
      sourceRef: "State privacy statutes (verify before acting)",
      publishedAt: "2026-09-25T00:00:00.000Z",
      seedFlag: true,
    },
  ];

  it("marks relevance per tenant and sorts relevant-new first", () => {
    const items = triageChanges(changes, foodNc);
    const byKey = new Map(items.map((i) => [i.key, i]));
    assert.equal(byKey.get("national-food")?.relevance, "relevant");
    assert.equal(byKey.get("nc-all")?.relevance, "relevant");
    assert.equal(byKey.get("saas-only")?.relevance, "not_relevant");
    assert.deepEqual(items.map((i) => i.key), ["national-food", "nc-all", "saas-only"]);
    for (const i of items) assert.equal(i.triage, "new");
  });

  it("merges tenant triage state by key and demotes triaged items", () => {
    const items = triageChanges(
      changes,
      foodNc,
      [
        { changeKey: "national-food", status: "reviewed" },
        { changeKey: "nc-all", status: "dismissed" },
      ],
    );
    const byKey = new Map(items.map((i) => [i.key, i]));
    assert.equal(byKey.get("national-food")?.triage, "reviewed");
    assert.equal(byKey.get("nc-all")?.triage, "dismissed");
    // Dismissed relevant item sinks below relevant-new ones.
    assert.deepEqual(
      items.map((i) => i.key),
      ["national-food", "nc-all", "saas-only"],
    );
  });

  it("ignores triage rows for unknown keys so stale rows can't invent items", () => {
    const items = triageChanges(changes, foodNc, [
      { changeKey: "ghost-change", status: "dismissed" as RadarTriageStatus },
    ]);
    assert.equal(items.length, 3);
    assert.ok(items.every((i) => i.triage === "new"));
  });
});

describe("changeToObligationSeed", () => {
  it("wires a change into a valid slice-1 obligation template", () => {
    const change = REGULATION_CHANGE_SEEDS[0];
    const template = changeToObligationSeed(change);
    assert.ok(
      template.key.startsWith("radar-"),
      "radar obligations must be key-prefixed",
    );
    assert.equal(template.key, `radar-${change.key}`);
    assert.equal(template.needsReview, true);
    assert.equal(template.renewalCadence, null);
    assert.match(template.description, /verify before acting/i);
    assert.match(template.description, /change radar/i);
    // The produced template must pass slice-1's own seed validation.
    validateSeedTemplates([template]);
  });

  it("preserves the change's industry/jurisdiction targeting", () => {
    const ncChange = REGULATION_CHANGE_SEEDS.find((c) =>
      c.jurisdictions.includes("NC"),
    );
    assert.ok(ncChange, "seed feed needs an NC change for this test");
    const template = changeToObligationSeed(ncChange!);
    assert.deepEqual(template.jurisdictions, ncChange!.jurisdictions);
    assert.deepEqual(template.industries, ncChange!.industries);
  });
});

describe("guardrails", () => {
  it("the disclaimer labels output as information, never advice", () => {
    assert.match(LEGAL_DISCLAIMER, /not legal advice/i);
    assert.match(LEGAL_DISCLAIMER, /licensed attorney/i);
  });

  it("seed data passes structural validation", () => {
    validateSeedChanges(REGULATION_CHANGE_SEEDS);
  });

  it("seed changes never invent bill numbers, statute citations, or dates", () => {
    // Same approach as slice 1: specifics that can't be verified must not
    // render as fact.
    const invented = [
      /form\s+[A-Z]?\d/i,
      /schedule\s+[A-Z]?\d/i,
      /§/,
      /U\.S\.C\./i,
      /Gen\.?\s*Stat/i,
      /\bH\.R\.\s*\d+/i,
      /\bS\.\s*\d+/i,
      /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, // specific calendar dates
    ];
    for (const c of REGULATION_CHANGE_SEEDS) {
      const text = `${c.title} ${c.plainEnglishSummary} ${c.sourceRef}`;
      for (const pattern of invented) {
        assert.doesNotMatch(
          text,
          pattern,
          `Change ${c.key} looks like it invents a specific (${pattern})`,
        );
      }
    }
  });

  it("seed changes carry no effective dates — nothing unverified renders as a date", () => {
    for (const c of REGULATION_CHANGE_SEEDS) {
      assert.equal(
        c.effectiveDate,
        null,
        `${c.key} has an effectiveDate but v1 seeds are illustrative, not verified`,
      );
    }
  });

  it("every seed change is flagged as seed data with a source reference", () => {
    for (const c of REGULATION_CHANGE_SEEDS) {
      assert.equal(c.seedFlag, true, `${c.key} must carry seedFlag: true`);
      assert.ok(c.sourceRef.trim().length > 0, `${c.key} missing sourceRef`);
    }
  });

  it("the seed feed is visibly labeled as illustrative, not live", () => {
    assert.match(SEED_FEED_NOTICE, /illustrative/i);
    assert.match(SEED_FEED_NOTICE, /not a live/i);
    const viewSource = readFileSync(
      new URL(
        "../../../app/dashboard/legal/views/RadarView.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    // The view badges the feed with a literal heading and renders the notice
    // the API ships (the API route test below proves that notice is the
    // shared SEED_FEED_NOTICE constant).
    assert.match(viewSource, /Illustrative seed data/, "view must badge the seed feed");
    assert.ok(
      viewSource.includes("seedFeedNotice"),
      "view must render the seed-feed notice prop",
    );
  });

  it("every radar API route carries the disclaimer and the seed-feed notice", () => {
    for (const route of [
      "../../../app/api/legal/radar/route.ts",
      "../../../app/api/legal/radar/[key]/route.ts",
      "../../../app/api/legal/radar/[key]/to-obligation/route.ts",
    ]) {
      const source = readFileSync(new URL(route, import.meta.url), "utf8");
      assert.ok(
        source.includes("LEGAL_DISCLAIMER"),
        `${route} must carry the disclaimer`,
      );
      assert.ok(
        source.includes("SEED_FEED_NOTICE"),
        `${route} must carry the seed-feed notice`,
      );
    }
  });

  it("validateSeedChanges rejects a change with an unregistered industry", () => {
    const bad: SeedRegulationChange[] = [
      {
        key: "bad-industry",
        title: "Bad",
        plainEnglishSummary: "Bad",
        industries: ["crypto"],
        jurisdictions: ["national"],
        category: "other",
        effectiveDate: null,
        sourceRef: "Nowhere",
        publishedAt: "2026-10-01T00:00:00.000Z",
        seedFlag: true,
      },
    ];
    assert.throws(() => validateSeedChanges(bad), /unregistered industry/);
  });

  it("validateSeedChanges rejects a change missing its source reference", () => {
    const bad: SeedRegulationChange[] = [
      {
        key: "no-source",
        title: "Bad",
        plainEnglishSummary: "Bad",
        industries: [],
        jurisdictions: ["national"],
        category: "other",
        effectiveDate: null,
        sourceRef: "  ",
        publishedAt: "2026-10-01T00:00:00.000Z",
        seedFlag: true,
      },
    ];
    assert.throws(() => validateSeedChanges(bad), /source reference/);
  });

  it("validateSeedChanges rejects a duplicate key", () => {
    const dup = [...REGULATION_CHANGE_SEEDS.slice(0, 1), ...REGULATION_CHANGE_SEEDS.slice(0, 1)];
    assert.throws(() => validateSeedChanges(dup), /Duplicate seed change key/);
  });
});
