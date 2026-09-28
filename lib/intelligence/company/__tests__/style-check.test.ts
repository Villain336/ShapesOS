// Marketr — Phase 13B Worker 4 tests: style-rule checking + enforcement.
// Run: npx tsx --test lib/intelligence/company/__tests__/style-check.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkOutputAgainstRules,
  compilePattern,
  enforceAgainstRules,
  StyleRuleBlockedError,
} from "../style-check";
import type { StyleRule } from "@prisma/client";

function rule(over: Partial<StyleRule>): StyleRule {
  return {
    id: `rule-${Math.random().toString(36).slice(2)}`,
    workspaceId: "ws-test",
    kind: "ban",
    pattern: "placeholder",
    replacement: null,
    severity: "flag",
    pinned: false,
    active: true,
    source: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as StyleRule;
}

const SEEDED = [
  rule({ id: "r-ban", kind: "ban", pattern: "cheap", severity: "block" }),
  rule({
    id: "r-require",
    kind: "require",
    pattern: "results may vary",
    severity: "flag",
  }),
  rule({
    id: "r-disclaimer",
    kind: "disclaimer",
    pattern: "not financial advice",
    severity: "block",
  }),
  rule({ id: "r-tone", kind: "tone", pattern: "be friendly", severity: "flag" }),
  rule({ id: "r-inactive", kind: "ban", pattern: "nevermatch", severity: "block", active: false }),
];

describe("checkOutputAgainstRules — seeded violations", () => {
  it("catches a banned phrase (case-insensitive)", () => {
    const { violations } = checkOutputAgainstRules(
      "This is a CHEAP trick that works.",
      SEEDED,
    );
    assert.ok(
      violations.some((v) => v.ruleId === "r-ban"),
      `expected r-ban violation, got: ${JSON.stringify(violations)}`,
    );
  });

  it("word-boundary: 'cheap' does not match 'cheaper'", () => {
    const { violations } = checkOutputAgainstRules(
      "Our cheaper plan includes results may vary and not financial advice.",
      SEEDED,
    );
    assert.ok(
      !violations.some((v) => v.ruleId === "r-ban"),
      `r-ban must not fire on 'cheaper', got: ${JSON.stringify(violations)}`,
    );
  });

  it("flags a missing required phrase", () => {
    const { violations } = checkOutputAgainstRules(
      "Our premium plan delivers great outcomes.",
      SEEDED,
    );
    const v = violations.find((x) => x.ruleId === "r-require");
    assert.ok(v, "expected r-require violation for missing phrase");
    assert.equal(v!.severity, "flag");
  });

  it("passes when the required phrase is present", () => {
    const { violations } = checkOutputAgainstRules(
      "Our premium plan delivers great outcomes. Results may vary.",
      SEEDED.filter((r) => r.id === "r-require"),
    );
    assert.equal(violations.length, 0);
  });

  it("catches a missing disclaimer", () => {
    const { violations } = checkOutputAgainstRules(
      "Buy the dip and retire early.",
      SEEDED,
    );
    const v = violations.find((x) => x.ruleId === "r-disclaimer");
    assert.ok(v, "expected r-disclaimer violation");
    assert.equal(v!.severity, "block");
  });

  it("tone rules flag (never block) even when stored as severity=block", () => {
    const { violations } = checkOutputAgainstRules("Great question, let's dig in", [
      rule({ id: "r-tone-block", kind: "tone", pattern: "^Great question", severity: "block" }),
    ]);
    assert.equal(violations.length, 1, "tone match must be flagged");
    assert.equal(violations[0].severity, "flag", "block on tone downgrades to flag");
    assert.doesNotThrow(
      () => enforceAgainstRules(violations),
      "tone violations must never refuse delivery",
    );
  });

  it("tone rules stay clean when the pattern does not match", () => {
    const { violations } = checkOutputAgainstRules(
      "anything at all",
      SEEDED.filter((r) => r.id === "r-tone"),
    );
    assert.equal(violations.length, 0);
  });

  it("ignores inactive rules", () => {
    const { violations } = checkOutputAgainstRules(
      "nevermatch appears here",
      SEEDED,
    );
    assert.ok(
      !violations.some((v) => v.ruleId === "r-inactive"),
      "inactive rules must not fire",
    );
  });

  it("supports explicit regex patterns", () => {
    const regexRule = rule({ id: "r-regex", kind: "ban", pattern: "\\d+%\\s+guaranteed", severity: "block" });
    const { violations } = checkOutputAgainstRules(
      "Get 200% guaranteed returns today.",
      [regexRule],
    );
    assert.equal(violations.length, 1);
  });

  it("flags (not throws) on a broken regex", () => {
    const broken = rule({ id: "r-broken", kind: "ban", pattern: "([invalid", severity: "block" });
    const { violations } = checkOutputAgainstRules("some text", [broken]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.severity, "flag");
  });
});

describe("compilePattern", () => {
  it("wraps plain phrases in word boundaries", () => {
    assert.ok(!compilePattern("cheap").test("cheaper"));
    assert.ok(compilePattern("cheap").test("so cheap!"));
  });
  it("is case-insensitive", () => {
    assert.ok(compilePattern("Cheap").test("CHEAP"));
  });
});

describe("enforceAgainstRules — fail-closed", () => {
  it("throws StyleRuleBlockedError on severity=block violations", () => {
    assert.throws(
      () =>
        enforceAgainstRules([
          { ruleId: "r-ban", kind: "ban", pattern: "cheap", severity: "block" },
        ]),
      (err) => {
        assert.ok(err instanceof StyleRuleBlockedError);
        assert.equal(err.violations.length, 1);
        assert.ok(err.message.includes("cheap"));
        return true;
      },
    );
  });

  it("returns (does not throw) on flag-only violations", () => {
    const res = enforceAgainstRules([
      { ruleId: "r-require", kind: "require", pattern: "results may vary", severity: "flag" },
    ]);
    assert.equal(res.blocked, false);
    assert.equal(res.violations.length, 1);
  });

  it("returns clean on zero violations", () => {
    const res = enforceAgainstRules([]);
    assert.deepEqual(res, { violations: [], blocked: false });
  });
});
