// Marketr — Legal/Compliance slice 1 tests: obligation computation engine.
// Run: npx tsx --test lib/legal/__tests__/obligations.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeObligations,
  templateAppliesToProfile,
  validateSeedTemplates,
} from "../obligations";
import { OBLIGATION_TEMPLATES } from "../seeds";
import {
  LEGAL_DISCLAIMER,
  validateLegalProfileInput,
  type LegalProfileInput,
  type SeedObligationTemplate,
} from "../types";

const foodNc: LegalProfileInput = {
  industry: "food",
  businessModel: "llc",
  jurisdictions: ["NC"],
};

const dronesNc: LegalProfileInput = {
  industry: "drones",
  businessModel: "sole_proprietor",
  jurisdictions: ["NC"],
};

const saasNoState: LegalProfileInput = {
  industry: "saas",
  businessModel: "corporation",
  // Engine-level profile: national baseline only, no state layer.
  jurisdictions: [],
};

describe("templateAppliesToProfile", () => {
  it("applies national templates to every profile", () => {
    const t = { industries: [], jurisdictions: ["national"] };
    assert.equal(templateAppliesToProfile(t, foodNc), true);
    assert.equal(templateAppliesToProfile(t, saasNoState), true);
  });

  it("applies NC templates only when NC is in the profile jurisdictions", () => {
    const t = { industries: [], jurisdictions: ["NC"] };
    assert.equal(templateAppliesToProfile(t, foodNc), true);
    assert.equal(templateAppliesToProfile(t, saasNoState), false);
  });

  it("filters by industry, with empty industries meaning all", () => {
    const foodOnly = { industries: ["food"], jurisdictions: ["national"] };
    assert.equal(templateAppliesToProfile(foodOnly, foodNc), true);
    assert.equal(templateAppliesToProfile(foodOnly, dronesNc), false);
    const all = { industries: [], jurisdictions: ["national"] };
    assert.equal(templateAppliesToProfile(all, dronesNc), true);
  });
});

describe("computeObligations — per-tenant generation", () => {
  it("generates a food + NC checklist with NC layering", () => {
    const list = computeObligations(foodNc, OBLIGATION_TEMPLATES);
    const keys = new Set(list.map((o) => o.key));
    // National baseline present.
    assert.ok(keys.has("federal-ein"));
    // NC layer present.
    assert.ok(keys.has("nc-sos-registration"));
    assert.ok(keys.has("nc-annual-report"));
    assert.ok(keys.has("nc-food-establishment-permit"));
    // Other industries excluded.
    assert.ok(!keys.has("faa-part-107"));
    assert.ok(!keys.has("saas-sales-tax-nexus"));
    assert.ok(!keys.has("service-agreements"));
  });

  it("generates a drones + NC checklist with the drone layer", () => {
    const list = computeObligations(dronesNc, OBLIGATION_TEMPLATES);
    const keys = new Set(list.map((o) => o.key));
    assert.ok(keys.has("faa-part-107"));
    assert.ok(keys.has("faa-drone-registration"));
    assert.ok(keys.has("nc-drone-operator-permit"));
    assert.ok(!keys.has("nc-food-establishment-permit"));
  });

  it("layers national under jurisdiction-specific: no-state profile gets national only", () => {
    const list = computeObligations(saasNoState, OBLIGATION_TEMPLATES);
    const keys = new Set(list.map((o) => o.key));
    assert.ok(keys.has("federal-ein"));
    assert.ok(keys.has("saas-sales-tax-nexus"));
    assert.ok(!keys.has("nc-sos-registration"));
    assert.ok(!keys.has("nc-annual-report"));
  });

  it("two tenants with different profiles get different maps — never generic", () => {
    const foodKeys = new Set(computeObligations(foodNc, OBLIGATION_TEMPLATES).map((o) => o.key));
    const droneKeys = new Set(
      computeObligations(dronesNc, OBLIGATION_TEMPLATES).map((o) => o.key),
    );
    assert.ok(foodKeys.has("nc-food-establishment-permit"));
    assert.ok(!droneKeys.has("nc-food-establishment-permit"));
    assert.ok(droneKeys.has("faa-part-107"));
    assert.ok(!foodKeys.has("faa-part-107"));
  });

  it("sorts by category then title", () => {
    const list = computeObligations(foodNc, OBLIGATION_TEMPLATES);
    const order = ["license", "filing", "tax", "insurance", "permit"];
    let last = -1;
    for (const o of list) {
      const idx = order.indexOf(o.category);
      assert.ok(idx >= last, `category order violated at ${o.key}`);
      last = idx;
    }
  });

  it("defaults every obligation to open with no overrides", () => {
    const list = computeObligations(foodNc, OBLIGATION_TEMPLATES);
    assert.ok(list.length > 0);
    for (const o of list) {
      assert.equal(o.status, "open");
      assert.equal(o.snoozedUntil, null);
      assert.equal(o.note, null);
    }
  });
});

describe("computeObligations — overrides", () => {
  it("merges snooze/dismiss/done status by template key", () => {
    const list = computeObligations(foodNc, OBLIGATION_TEMPLATES, [
      { templateKey: "federal-ein", status: "done", snoozedUntil: null, note: null },
      {
        templateKey: "nc-annual-report",
        status: "snoozed",
        snoozedUntil: "2026-11-01T00:00:00.000Z",
        note: "Waiting on accountant",
      },
      { templateKey: "local-business-license", status: "dismissed", snoozedUntil: null, note: null },
    ]);
    const byKey = new Map(list.map((o) => [o.key, o]));
    assert.equal(byKey.get("federal-ein")?.status, "done");
    assert.equal(byKey.get("nc-annual-report")?.status, "snoozed");
    assert.equal(
      byKey.get("nc-annual-report")?.snoozedUntil,
      "2026-11-01T00:00:00.000Z",
    );
    assert.equal(byKey.get("nc-annual-report")?.note, "Waiting on accountant");
    assert.equal(byKey.get("local-business-license")?.status, "dismissed");
  });

  it("ignores override keys that match no template — stale rows can't invent obligations", () => {
    const before = computeObligations(foodNc, OBLIGATION_TEMPLATES).length;
    const after = computeObligations(foodNc, OBLIGATION_TEMPLATES, [
      { templateKey: "not-a-real-template", status: "done", snoozedUntil: null, note: null },
    ]).length;
    assert.equal(after, before);
  });
});

describe("validateLegalProfileInput", () => {
  it("accepts a valid profile", () => {
    validateLegalProfileInput(foodNc);
  });

  it("rejects an unknown industry", () => {
    assert.throws(
      () => validateLegalProfileInput({ ...foodNc, industry: "crypto" }),
      /INVALID_INDUSTRY/,
    );
  });

  it("rejects an unknown business model", () => {
    assert.throws(
      () => validateLegalProfileInput({ ...foodNc, businessModel: "dao" }),
      /INVALID_BUSINESS_MODEL/,
    );
  });

  it("rejects empty and unknown jurisdictions", () => {
    assert.throws(
      () => validateLegalProfileInput({ ...foodNc, jurisdictions: [] }),
      /INVALID_JURISDICTIONS/,
    );
    assert.throws(
      () => validateLegalProfileInput({ ...foodNc, jurisdictions: ["XX"] }),
      /INVALID_JURISDICTIONS/,
    );
  });
});

describe("guardrails", () => {
  it("the disclaimer labels output as information, never advice", () => {
    assert.match(LEGAL_DISCLAIMER, /not legal advice/i);
    assert.match(LEGAL_DISCLAIMER, /licensed attorney/i);
  });

  it("seed data passes structural validation", () => {
    validateSeedTemplates(OBLIGATION_TEMPLATES);
  });

  it("seed templates never invent form numbers, statute citations, or deadlines", () => {
    // Guardrail: specifics that can't be verified must not render as fact.
    const invented = [
      /form\s+[A-Z]?\d/i,
      /schedule\s+[A-Z]?\d/i,
      /§/,
      /U\.S\.C\./i,
      /Gen\.?\s*Stat/i,
      /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, // specific calendar deadlines
    ];
    for (const t of OBLIGATION_TEMPLATES) {
      const text = `${t.title} ${t.description} ${t.renewalCadence ?? ""}`;
      for (const pattern of invented) {
        assert.doesNotMatch(
          text,
          pattern,
          `Template ${t.key} looks like it invents a specific (${pattern})`,
        );
      }
    }
  });

  it("every seed template carries a source reference", () => {
    for (const t of OBLIGATION_TEMPLATES) {
      assert.ok(t.sourceRef.trim().length > 0, `${t.key} missing sourceRef`);
    }
  });

  it("insurance templates name the licensed partner and offer no binding path", () => {
    const insurance = OBLIGATION_TEMPLATES.filter((t) => t.category === "insurance");
    assert.ok(insurance.length > 0, "seed has no insurance obligations");
    for (const t of insurance) {
      assert.match(t.description, /licensed/i, `${t.key} must name the licensed partner`);
      assert.doesNotMatch(
        t.description,
        /buy now|get a quote|apply now|click here|sign up/i,
        `${t.key} must not present a binding path`,
      );
    }
  });

  it("validateSeedTemplates rejects a template with an unregistered industry", () => {
    const bad: SeedObligationTemplate[] = [
      {
        key: "bad-industry",
        industries: ["crypto"],
        jurisdictions: ["national"],
        category: "filing",
        title: "Bad",
        description: "Bad",
        sourceRef: "Nowhere",
        renewalCadence: null,
        needsReview: true,
      },
    ];
    assert.throws(() => validateSeedTemplates(bad), /unregistered industry/);
  });

  it("validateSeedTemplates rejects a template missing its source reference", () => {
    const bad: SeedObligationTemplate[] = [
      {
        key: "no-source",
        industries: [],
        jurisdictions: ["national"],
        category: "filing",
        title: "Bad",
        description: "Bad",
        sourceRef: "  ",
        renewalCadence: null,
        needsReview: true,
      },
    ];
    assert.throws(() => validateSeedTemplates(bad), /source reference/);
  });
});
