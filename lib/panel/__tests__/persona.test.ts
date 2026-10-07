// Phase 19B (WS=panel) — persona spec (zod), fragments and founder edits.
// Ported from the prototype's test/persona.test.ts (12 cases) and the
// founder-edit half of test/derive.test.ts (3 cases), plus the zod-schema
// cases the brief adds.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFounderEdits,
  assertValidPersonaSpec,
  FRAGMENTS,
  isCalibratedSpec,
  mergeFragments,
  parsePersonaSpec,
  PersonaEditsSchema,
  PersonaValidationError,
  validatePersonaSpec,
  type PersonaFragment,
} from "../persona";
import { validSpec } from "./fixtures";

const paths = (spec: unknown) => validatePersonaSpec(spec).map((i) => i.path);

describe("persona validation (zod)", () => {
  it("accepts a valid spec", () => {
    assert.deepEqual(validatePersonaSpec(validSpec()), []);
    assert.doesNotThrow(() => assertValidPersonaSpec(validSpec()));
  });

  it("rejects a non-object", () => {
    assert.ok(validatePersonaSpec(null).length > 0);
    assert.throws(() => assertValidPersonaSpec("nope"), PersonaValidationError);
  });

  it("rejects missing identity name/role", () => {
    const p = paths({ ...validSpec(), identity: { name: "", role: "" } });
    assert.ok(p.includes("identity.name"));
    assert.ok(p.includes("identity.role"));
  });

  it("rejects out-of-range Big Five and skepticism", () => {
    const bad = validSpec();
    bad.bigFive.openness = 1.5;
    bad.skepticism = -0.1;
    const p = paths(bad);
    assert.ok(p.includes("bigFive.openness"));
    assert.ok(p.includes("skepticism"));
  });

  it("rejects bad currency and negative budget", () => {
    const bad = validSpec();
    bad.budget.currency = "usd";
    bad.budget.monthlyMax = -5;
    const p = paths(bad);
    assert.ok(p.includes("budget.currency"));
    assert.ok(p.includes("budget.monthlyMax"));
  });

  it("rejects empty goals and bad objection severity, with the prototype's path shape", () => {
    const bad = validSpec({ goals: [], knownObjections: [{ text: "x", severity: "extreme" as never }] });
    const p = paths(bad);
    assert.ok(p.includes("goals"));
    assert.ok(p.includes("knownObjections[0].severity"));
  });

  it("error message lists all issues", () => {
    assert.throws(() => assertValidPersonaSpec({}), (e: unknown) => e instanceof PersonaValidationError && e.message.includes("identity") && e.issues.length >= 5);
  });

  it("parsePersonaSpec drops keys the schema doesn't know (untrusted JSON)", () => {
    const parsed = parsePersonaSpec({ ...validSpec(), injected: "<script>" });
    assert.equal("injected" in parsed, false);
  });

  it("a persona is calibrated only when it cites an interview", () => {
    assert.equal(isCalibratedSpec(validSpec({ sourceTranscriptIds: ["t1"] })), true);
    assert.equal(isCalibratedSpec(validSpec({ sourceTranscriptIds: [] })), false);
    assert.equal(isCalibratedSpec(validSpec({ sourceTranscriptIds: ["  "] })), false);
  });
});

describe("fragment merging", () => {
  it("merges hostile-cfo fragment into a base spec", () => {
    const merged = mergeFragments(validSpec(), [FRAGMENTS["hostile-cfo"]!]);
    assert.equal(merged.occupation, "Chief Financial Officer");
    assert.equal(merged.skepticism, 0.95);
    assert.equal(merged.bigFive.conscientiousness, 0.9);
    assert.equal(merged.bigFive.openness, 0.6);
    assert.ok(merged.goals.includes("cut reporting time"));
    assert.ok(merged.goals.includes("cut costs"));
    assert.ok(merged.preferences.dislikes.includes("spreadsheets"));
    assert.ok(merged.preferences.dislikes.includes("vague marketing claims"));
    assert.ok(merged.knownObjections.some((o) => o.text.includes("ROI math")));
    assert.ok(merged.knownObjections.some((o) => o.text.includes("team size")));
  });

  it("does not mutate the base spec", () => {
    const base = validSpec();
    const snapshot = JSON.stringify(base);
    mergeFragments(base, [FRAGMENTS["price-sensitive-bootstrapper"]!]);
    assert.equal(JSON.stringify(base), snapshot);
  });

  it("later fragments win on scalars; arrays dedupe", () => {
    const merged = mergeFragments(validSpec(), [FRAGMENTS["hostile-cfo"]!, FRAGMENTS["price-sensitive-bootstrapper"]!]);
    assert.equal(merged.skepticism, 0.7);
    assert.equal(merged.occupation, "Chief Financial Officer");
    assert.equal(merged.budget.monthlyMax, 50);
    assert.equal(merged.budget.hardCap, true);
    const dupe: PersonaFragment = { fragmentName: "dupe", goals: ["cut reporting time"] };
    assert.equal(mergeFragments(validSpec(), [dupe]).goals.filter((g) => g === "cut reporting time").length, 1);
  });

  it("clamps bigFive and skepticism to [0,1]", () => {
    const merged = mergeFragments(validSpec(), [{ fragmentName: "wild", skepticism: 5, bigFive: { openness: -2 } }]);
    assert.equal(merged.skepticism, 1);
    assert.equal(merged.bigFive.openness, 0);
  });

  it("merged spec still validates", () => {
    assert.deepEqual(validatePersonaSpec(mergeFragments(validSpec(), Object.values(FRAGMENTS))), []);
  });
});

describe("applyFounderEdits (the founder's veto / edit handle)", () => {
  it("applies edits and re-validates", () => {
    const edited = applyFounderEdits(validSpec(), {
      occupation: "VP Finance",
      skepticism: 0.9,
      goals: ["prove ROI in one quarter"],
      identity: { role: "VP Finance" },
      budget: { monthlyMax: 500, hardCap: true },
      knownObjections: [{ text: "No ROI math, no deal", severity: "high", sourceTranscriptId: "t1" }],
    });
    assert.equal(edited.occupation, "VP Finance");
    assert.equal(edited.identity.role, "VP Finance");
    assert.equal(edited.identity.name, "Dana Reyes");
    assert.equal(edited.skepticism, 0.9);
    assert.deepEqual(edited.goals, ["prove ROI in one quarter"]);
    assert.equal(edited.budget.monthlyMax, 500);
    assert.equal(edited.budget.hardCap, true);
    assert.equal(edited.budget.currency, "USD");
  });

  it("rejects edits that break the spec", () => {
    assert.throws(() => applyFounderEdits(validSpec(), { skepticism: 2 }), PersonaValidationError);
    assert.throws(() => applyFounderEdits(validSpec(), { goals: [] }), PersonaValidationError);
  });

  it("does not mutate the input spec", () => {
    const base = validSpec();
    const snapshot = JSON.stringify(base);
    applyFounderEdits(base, { occupation: "VP Finance", skepticism: 0.9 });
    assert.equal(JSON.stringify(base), snapshot);
  });

  it("PersonaEditsSchema refuses a wrongly-typed edit from untrusted JSON", () => {
    assert.equal(PersonaEditsSchema.safeParse({ goals: "not an array" }).success, false);
    assert.equal(PersonaEditsSchema.safeParse({ budget: { monthlyMax: 60 } }).success, true);
  });
});
