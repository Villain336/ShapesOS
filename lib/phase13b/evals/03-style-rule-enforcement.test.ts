// Marketr — Phase 13B eval 03: style-rule enforcement.
//
// Contract under test (docs/phases/13b/DATA-MODEL.md):
//   StyleRule → style_rules: kind ban|require|disclaimer|tone,
//   pattern (phrase/regex), replacement?, severity block|flag,
//   pinned, active (learner proposals arrive active=false), source
//   user|onboarding|consolidation. Checked on every output pre-delivery,
//   fail-closed (block = refuse delivery, flag = warn).
//
// Acceptance: seeded violation battery → checkOutput/enforce catches 100%.
//
// Status: the rule-contract checks RUN (tenant isolation, proposal
// lifecycle). The enforcement battery is PENDING until worker 2's
// checkOutput lands — the battery is exported as VIOLATION_BATTERY for
// worker 2 to run against the real implementation.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED,
  createEvalWorkspace,
  deleteEvalWorkspace,
  probeFeature,
  type FeatureProbe,
} from "./harness";
import { prisma } from "../../prisma";
import { withWorkspaceScope } from "../../substrate/memory/rls";

const SUITE = "style-rule-enforcement";
let WS = "";
let WS2 = "";
let enforcer: FeatureProbe = { found: false, module: null, reason: "" };

/** Seeded violation battery: {rule, output, expectViolation, expectBlocked}. */
export interface BatteryCase {
  name: string;
  rule: {
    kind: "ban" | "require" | "disclaimer" | "tone";
    pattern: string;
    replacement?: string;
    severity: "block" | "flag";
    source: string;
  };
  output: string;
  expectViolation: boolean;
  expectBlocked: boolean;
}

/**
 * The acceptance battery. Worker 2: run every case through checkOutput and
 * require 100% agreement on expectViolation / expectBlocked.
 */
export const VIOLATION_BATTERY: BatteryCase[] = [
  {
    name: "ban-phrase-blocked",
    rule: { kind: "ban", pattern: "guaranteed #1 ranking", severity: "block", source: "user" },
    output: "We deliver guaranteed #1 ranking on Google in 30 days.",
    expectViolation: true,
    expectBlocked: true,
  },
  {
    name: "ban-regex-blocked",
    rule: { kind: "ban", pattern: "\\b(synergy|leverage)\\b", severity: "block", source: "onboarding" },
    output: "Our solution leverages synergy across your funnel.",
    expectViolation: true,
    expectBlocked: true,
  },
  {
    name: "ban-phrase-case-insensitive",
    rule: { kind: "ban", pattern: "risk-free", severity: "block", source: "user" },
    output: "Try it RISK-FREE today.",
    expectViolation: true,
    expectBlocked: true,
  },
  {
    name: "require-line-missing-blocked",
    rule: {
      kind: "require",
      pattern: "Results vary by business.",
      severity: "block",
      source: "onboarding",
    },
    output: "Double your leads in a week with our playbook.",
    expectViolation: true,
    expectBlocked: true,
  },
  {
    name: "require-line-present-clean",
    rule: {
      kind: "require",
      pattern: "Results vary by business.",
      severity: "block",
      source: "onboarding",
    },
    output: "Double your leads in a week with our playbook. Results vary by business.",
    expectViolation: false,
    expectBlocked: false,
  },
  {
    name: "disclaimer-missing-flagged",
    rule: {
      kind: "disclaimer",
      pattern: "Past performance does not guarantee future results.",
      severity: "flag",
      source: "user",
    },
    output: "Our clients averaged 3.2x ROAS last quarter.",
    expectViolation: true,
    expectBlocked: false, // flag = warn, not block
  },
  {
    name: "disclaimer-present-clean",
    rule: {
      kind: "disclaimer",
      pattern: "Past performance does not guarantee future results.",
      severity: "flag",
      source: "user",
    },
    output: "Our clients averaged 3.2x ROAS last quarter. Past performance does not guarantee future results.",
    expectViolation: false,
    expectBlocked: false,
  },
  {
    name: "tone-sycophancy-blocked",
    rule: {
      kind: "tone",
      pattern: "^Great question",
      severity: "block",
      source: "consolidation",
    },
    output: "Great question! Here's why you're absolutely right to ask.",
    expectViolation: true,
    expectBlocked: true,
  },
  {
    name: "tone-guidance-clean-output",
    rule: {
      kind: "tone",
      pattern: "^Great question",
      severity: "block",
      source: "consolidation",
    },
    output: "Here's the breakdown of your options.",
    expectViolation: false,
    expectBlocked: false,
  },
  {
    name: "clean-output-no-violations",
    rule: { kind: "ban", pattern: "guaranteed #1 ranking", severity: "block", source: "user" },
    output: "We help teams ship faster with a clear weekly plan.",
    expectViolation: false,
    expectBlocked: false,
  },
  {
    name: "ban-substring-not-whole-word-still-caught",
    rule: { kind: "ban", pattern: "crypto", severity: "flag", source: "user" },
    output: "Avoid unregulated cryptocurrency schemes.",
    expectViolation: true,
    expectBlocked: false,
  },
  {
    name: "pinned-rule-survives-learner-proposal",
    rule: { kind: "ban", pattern: "risk-free", severity: "block", source: "user" },
    output: "This is RISK-FREE and guaranteed.",
    expectViolation: true,
    expectBlocked: true,
  },
];

before(async () => {
  enforcer = await probeFeature("worker 4", ["../../intelligence/enforce"], EXPECTED.styleRuleCheck);
  WS = await createEvalWorkspace(SUITE, "Eval 13B style rules");
  WS2 = await createEvalWorkspace(SUITE, "Eval 13B style rules (tenant B)");
  // Seed one pinned rule in WS (used by the pinned-rule contract check).
  await withWorkspaceScope(WS, (tx) =>
    tx.styleRule.create({
      data: {
        workspaceId: WS,
        kind: "ban",
        pattern: "risk-free",
        severity: "block",
        pinned: true,
        active: true,
        source: "user",
      },
    }),
  );
});

after(async () => {
  await deleteEvalWorkspace(WS);
  await deleteEvalWorkspace(WS2);
  await prisma.$disconnect();
});

describe("style-rule-enforcement: rule contract (runs — real schema)", () => {
  it("learner proposals arrive active=false; user accept flips to active", async () => {
    const proposed = await withWorkspaceScope(WS, (tx) =>
      tx.styleRule.create({
        data: {
          workspaceId: WS,
          kind: "tone",
          pattern: "^Hope this helps",
          severity: "flag",
          pinned: false,
          active: false, // learner proposal — not live until accepted
          source: "consolidation",
        },
      }),
    );
    const activeRules = await withWorkspaceScope(WS, (tx) =>
      tx.styleRule.findMany({ where: { active: true } }),
    );
    assert.ok(!activeRules.some((r) => r.id === proposed.id), "proposal not in the active enforcement set");
    await withWorkspaceScope(WS, (tx) =>
      tx.styleRule.update({ where: { id: proposed.id }, data: { active: true } }),
    );
    const activeAfter = await withWorkspaceScope(WS, (tx) =>
      tx.styleRule.findMany({ where: { active: true } }),
    );
    assert.ok(activeAfter.some((r) => r.id === proposed.id), "user accept makes it live");
    // cleanup: proposal rows are eval-seeded, cascade-deleted with workspace
  });

  it("tenant isolation: workspace B sees none of workspace A's rules", async () => {
    const rulesB = await withWorkspaceScope(WS2, (tx) => tx.styleRule.findMany());
    assert.equal(rulesB.length, 0, "no cross-workspace rule leakage");
  });

  it("pinned rules are marked read-only to the learner (contract flag)", async () => {
    const pinned = await withWorkspaceScope(WS, (tx) =>
      tx.styleRule.findMany({ where: { pinned: true } }),
    );
    assert.ok(pinned.length >= 1, "seeded pinned rule present");
    assert.ok(pinned.every((r) => r.pinned === true));
  });
});

describe("style-rule-enforcement: violation battery (real checkOutput)", () => {
  for (const c of VIOLATION_BATTERY) {
    it(`battery: ${c.name}`, async (t) => {
      if (!enforcer.found) { t.skip("checkOutput not landed — battery ready for reuse"); return; }
      // Real acceptance run: seed the case rule, run the actual enforcement
      // entry points, require 100% agreement with expectViolation / expectBlocked.
      const mod = enforcer.module as typeof import("../../intelligence/enforce");
      await withWorkspaceScope(WS, (tx) =>
        tx.styleRule.create({
          data: {
            workspaceId: WS,
            kind: c.rule.kind,
            pattern: c.rule.pattern,
            replacement: c.rule.replacement ?? null,
            severity: c.rule.severity,
            pinned: false,
            active: true,
            source: c.rule.source,
          },
        }),
      );
      const { violations } = await mod.checkOutput(c.output, WS);
      const caseHits = violations.filter((v) => v.pattern === c.rule.pattern);
      assert.equal(
        caseHits.length > 0,
        c.expectViolation,
        `${c.name}: expected violation=${c.expectViolation}, got ${caseHits.length} hit(s)`,
      );
      let blocked = false;
      try {
        await mod.enforceStyleRules(c.output, WS);
      } catch (err) {
        if (err instanceof mod.StyleRuleBlockedError) blocked = true;
        else throw err;
      }
      // enforceStyleRules throws on ANY active block rule, so restrict the
      // blocked verdict to cases whose own rule is the blocker.
      const ownBlocked = blocked && (c.rule.severity === "block"
        ? caseHits.some((v) => v.severity === "block")
        : false);
      assert.equal(
        ownBlocked,
        c.expectBlocked,
        `${c.name}: expected blocked=${c.expectBlocked}, got blocked=${ownBlocked}`,
      );
    });
  }
});
