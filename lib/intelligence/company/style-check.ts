// Marketr — Phase 13B Worker 4: style-rule checking + fail-closed enforcement.
//
// StyleRules are the hard constraints on every agent output (spec §2):
//   ban        → the phrase/regex must NOT appear
//   require    → the phrase must appear
//   disclaimer → compliance text must appear
//   tone       → guidance (included in prompts; not machine-checkable)
//
// Severity: "block" = refuse delivery, "flag" = warn. Fail-closed:
// enforceStyleRules() throws on block violations — the delivery paths catch
// it and deliver a refusal instead of the violating text.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { StyleRule } from "@prisma/client";

export interface StyleViolation {
  ruleId: string;
  kind: string;
  pattern: string;
  severity: "block" | "flag";
}

export interface StyleCheckResult {
  violations: StyleViolation[];
}

const REGEX_META = /[\\^$.*+?()[\]{}|]/;

/**
 * Compile a rule pattern. Plain phrases (no regex metacharacters) are
 * wrapped in \b…\b word boundaries so "cheap" doesn't match "cheaper".
 * Explicit regexes pass through as-is. Always case-insensitive.
 */
export function compilePattern(pattern: string): RegExp {
  const source = REGEX_META.test(pattern) ? pattern : `\\b${escapeRegex(pattern)}\\b`;
  return new RegExp(source, "i");
}

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Check one rule against the text; returns the violation or null. */
export function checkRule(rule: StyleRule, text: string): StyleViolation | null {
  const re = compilePattern(rule.pattern);
  const present = re.test(text);
  switch (rule.kind) {
    case "ban":
      return present
        ? { ruleId: rule.id, kind: rule.kind, pattern: rule.pattern, severity: rule.severity }
        : null;
    case "require":
    case "disclaimer":
      return present
        ? null
        : { ruleId: rule.id, kind: rule.kind, pattern: rule.pattern, severity: rule.severity };
    case "tone":
    default:
      // Tone is guidance, not machine-checkable — it travels in the prompt,
      // never blocks delivery.
      return null;
  }
}

/** Load the workspace's ACTIVE style rules (RLS-scoped). */
export async function loadActiveStyleRules(workspaceId: string): Promise<StyleRule[]> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.styleRule.findMany({
      where: { workspaceId, active: true },
      orderBy: { createdAt: "asc" },
    }),
  );
}

/** Check text against all active rules for the workspace. */
export async function checkOutput(
  text: string,
  workspaceId: string,
): Promise<StyleCheckResult> {
  const rules = await loadActiveStyleRules(workspaceId);
  const violations: StyleViolation[] = [];
  for (const rule of rules) {
    try {
      const v = checkRule(rule, text);
      if (v) violations.push(v);
    } catch {
      // A broken regex must never pass silently-as-ok nor crash delivery —
      // treat a compile failure as a flag on the rule itself.
      violations.push({
        ruleId: rule.id,
        kind: rule.kind,
        pattern: rule.pattern,
        severity: "flag",
      });
    }
  }
  return { violations };
}

/** Pure (DB-free) check used by unit tests and by callers that already loaded rules. */
export function checkOutputAgainstRules(
  text: string,
  rules: StyleRule[],
): StyleCheckResult {
  const violations: StyleViolation[] = [];
  for (const rule of rules) {
    if (!rule.active) continue;
    try {
      const v = checkRule(rule, text);
      if (v) violations.push(v);
    } catch {
      violations.push({
        ruleId: rule.id,
        kind: rule.kind,
        pattern: rule.pattern,
        severity: "flag",
      });
    }
  }
  return { violations };
}

/** Thrown by enforceStyleRules() when a severity=block rule is violated. */
export class StyleRuleBlockedError extends Error {
  violations: StyleViolation[];
  constructor(violations: StyleViolation[]) {
    super(
      `Blocked by ${violations.length} style rule(s): ${violations
        .map((v) => `"${v.pattern}" (${v.kind})`)
        .join(", ")}`,
    );
    this.name = "StyleRuleBlockedError";
    this.violations = violations;
  }
}

export interface EnforceResult {
  violations: StyleViolation[];
  blocked: boolean;
}

/**
 * Fail-closed enforcement. Runs the style check; on any severity=block
 * violation THROWS StyleRuleBlockedError (caller must refuse delivery).
 * Flag violations are returned for warning decoration.
 */
export async function enforceStyleRules(
  text: string,
  workspaceId: string,
): Promise<EnforceResult> {
  const { violations } = await checkOutput(text, workspaceId);
  return enforceAgainstRules(violations);
}

/**
 * DB-free core of enforceStyleRules: throws StyleRuleBlockedError on any
 * severity=block violation. Unit-tested directly; the DB-backed wrapper
 * above delegates to it.
 */
export function enforceAgainstRules(violations: StyleViolation[]): EnforceResult {
  const blocking = violations.filter((v) => v.severity === "block");
  if (blocking.length > 0) throw new StyleRuleBlockedError(blocking);
  return { violations, blocked: false };
}

/**
 * Render active rules as a verbatim HARD CONSTRAINTS prompt section.
 * Per spec §4: style rules are always first and always win.
 */
export function renderStyleRulesSection(rules: StyleRule[]): string {
  if (rules.length === 0) return "";
  const lines = [
    "## HARD CONSTRAINTS — STYLE RULES (never violate; these override everything below)",
  ];
  for (const rule of rules) {
    const replacement =
      rule.kind === "ban" && rule.replacement
        ? ` — say "${rule.replacement}" instead`
        : "";
    const context =
      (rule.kind === "require" || rule.kind === "disclaimer") && rule.replacement
        ? ` (${rule.replacement})`
        : "";
    lines.push(
      `- [${rule.kind}/${rule.severity}] "${rule.pattern}"${replacement}${context}`,
    );
  }
  return lines.join("\n");
}
