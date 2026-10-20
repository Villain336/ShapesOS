// Marketr — Phase 13B Worker 4: style-rule checking + fail-closed enforcement.
//
// StyleRules are the hard constraints on every agent output (spec §2):
//   ban        → the phrase/regex must NOT appear
//   require    → the phrase must appear
//   disclaimer → compliance text must appear
//   tone       → guidance: machine-checked, but NEVER machine-enforced —
//                a severity=block tone rule is DOWNGRADED to flag (flagged
//                for user review, never refused). Product decision 2026-09-27.
//
// Severity: "block" = refuse delivery, "flag" = warn. Fail-closed:
// enforceStyleRules() throws on block violations — the delivery paths catch
// it and deliver a refusal instead of the violating text. Hard ban rules on
// banned words/phrases stay blocking; only tone rules are exempt.
//
// Ban-pattern matching is whole-word: plain phrases are wrapped in \b…\b
// word boundaries, so "ass" never matches "class". Product decision 2026-09-27.

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
 * wrapped in \b…\b word boundaries so "cheap" doesn't match "cheaper"
 * (whole-word semantics, product decision 2026-09-27).
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
      // Tone is guidance: machine-checked, but a severity=block tone rule is
      // DOWNGRADED to flag — flagged for user review, never refused delivery.
      // (Product decision 2026-09-27: tone rules flag, they don't block.)
      return present
        ? { ruleId: rule.id, kind: rule.kind, pattern: rule.pattern, severity: "flag" }
        : null;
    default:
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

// ── Phase 17 (latency): the per-workspace memo the chat turn reads ─────────
//
// A chat turn used to load the active rules three times (the prompt's hard
// constraints, the stream guard, the final enforcement). The turn now reads
// them once through loadActiveStyleRulesMemo(): one load per workspace per
// process, kept STYLE_RULES_MEMO_MS, and dropped at once by
// invalidateStyleRules() on every write path in this process (the style-rule
// routes, the learning pass). Another replica sees an edit within the TTL.
// The direct loader above stays uncached: the enforcement entry points other
// surfaces call (checkOutput / enforceStyleRules) and the evals read fresh.

export const STYLE_RULES_MEMO_MS = 10_000;
const styleRulesMemo = new Map<string, { at: number; rules: Promise<StyleRule[]> }>();

export async function loadActiveStyleRulesMemo(workspaceId: string, now: () => number = Date.now): Promise<StyleRule[]> {
  const hit = styleRulesMemo.get(workspaceId);
  if (hit && now() - hit.at < STYLE_RULES_MEMO_MS) return hit.rules;
  const rules = loadActiveStyleRules(workspaceId);
  styleRulesMemo.set(workspaceId, { at: now(), rules });
  rules.catch(() => styleRulesMemo.delete(workspaceId));
  // Bounded: forget the oldest entries past 1,000 workspaces in this process.
  if (styleRulesMemo.size > 1_000) {
    const oldest = styleRulesMemo.keys().next().value;
    if (oldest !== undefined) styleRulesMemo.delete(oldest);
  }
  return rules;
}

/** A style rule changed in this workspace: the next turn reloads. */
export function invalidateStyleRules(workspaceId: string): void {
  styleRulesMemo.delete(workspaceId);
}

/** Test seam. */
export function _resetStyleRulesMemoForTests(): void {
  styleRulesMemo.clear();
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
    // Tone rules never block: render the effective severity so the prompt is
    // honest about what the enforcer will do.
    const effectiveSeverity =
      rule.kind === "tone" && rule.severity === "block" ? "flag" : rule.severity;
    const replacement =
      rule.kind === "ban" && rule.replacement
        ? ` — say "${rule.replacement}" instead`
        : "";
    const context =
      (rule.kind === "require" || rule.kind === "disclaimer") && rule.replacement
        ? ` (${rule.replacement})`
        : "";
    lines.push(
      `- [${rule.kind}/${effectiveSeverity}] "${rule.pattern}"${replacement}${context}`,
    );
  }
  return lines.join("\n");
}
