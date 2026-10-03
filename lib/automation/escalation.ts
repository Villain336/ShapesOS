// Marketr — Phase 9 M6: escalation rules (docs/specs/SPEC-PHASE9.md §P9E, research §5).
//
// Escalation rules beat blanket approval queues (which degrade to
// reflex-confirming): the system stops on DEFINED conditions — dollar
// threshold, unseen treatment, no source record, external audience.
// A rule whose effect is "require_approval" forces the action to Tier 2
// regardless of its automation toggle.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "../substrate/graph/rls";

export type EscalationConditionKind =
  | "amount_above"
  | "unseen_treatment"
  | "no_source_record"
  | "external_audience";

export type EscalationEffect = "require_approval" | "notify";

export interface EscalationCondition {
  kind: EscalationConditionKind;
  /** For amount_above: cents in the workspace's default currency. */
  value?: number;
}

export interface EscalationRule {
  id: string;
  name: string;
  condition: EscalationCondition;
  action: EscalationEffect;
  enabled: boolean;
  position: number;
}

/** The action context an escalation rule evaluates. Mirrors TierAction
 *  (lib/orchestrator/authority.ts) plus the escalation-specific signals. */
export interface EscalationAction {
  kind: string;
  amountCents?: number | null;
  currency?: string;
  channel?: string;
  description?: string;
  /** True when the action reaches people outside the workspace's owned channels. */
  externalAudience?: boolean;
  /** Source record the action derives from (draft id, brief id, …). */
  sourceRecordId?: string | null;
  /** Whether this exact treatment has been seen/approved before. */
  seenTreatment?: boolean;
}

export interface EscalationResult {
  /** True when at least one enabled rule with action=require_approval matched. */
  forceTier2: boolean;
  /** Names of matched rules that force approval. */
  matched: string[];
  /** Names of matched notify-only rules (for the audit trail). */
  notified: string[];
}

function conditionMatches(
  condition: EscalationCondition,
  action: EscalationAction,
): boolean {
  switch (condition.kind) {
    case "amount_above": {
      const limit = condition.value;
      if (typeof limit !== "number" || !Number.isFinite(limit)) return false;
      if (action.amountCents === undefined || action.amountCents === null) return false;
      return action.amountCents > limit;
    }
    case "unseen_treatment":
      // Fires when the treatment is explicitly unseen. Unknown (undefined)
      // is fail-open here — the amount/audience rules still guard — because
      // unseen-ness is a learning signal, not a hard fact.
      return action.seenTreatment === false;
    case "no_source_record":
      return action.sourceRecordId === undefined || action.sourceRecordId === null;
    case "external_audience":
      return action.externalAudience === true;
    default:
      return false;
  }
}

/**
 * evaluateEscalation — PURE. Returns whether the action must be forced to
 * Tier 2 (explicit human approval), plus which rules matched for the audit
 * trail. Disabled rules never match.
 */
export function evaluateEscalation(
  action: EscalationAction,
  rules: EscalationRule[],
): EscalationResult {
  const matched: string[] = [];
  const notified: string[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!conditionMatches(rule.condition, action)) continue;
    if (rule.action === "require_approval") matched.push(rule.name);
    else notified.push(rule.name);
  }
  return { forceTier2: matched.length > 0, matched, notified };
}

// ---------------------------------------------------------------------------
// Defaults (seeded per workspace on first read; user-editable via API)
// ---------------------------------------------------------------------------

export const DEFAULT_ESCALATION_RULES: Array<
  Pick<EscalationRule, "name" | "condition" | "action" | "position">
> = [
  {
    name: "External audience",
    condition: { kind: "external_audience" },
    action: "require_approval",
    position: 0,
  },
  {
    name: "Amount above threshold",
    condition: { kind: "amount_above", value: 10_000 },
    action: "require_approval",
    position: 1,
  },
  {
    name: "Publish without a source record",
    condition: { kind: "no_source_record" },
    action: "require_approval",
    position: 2,
  },
];

/** PURE: return the defaults when the workspace has no rules yet. */
export function ensureDefaultRules(existing: EscalationRule[]): EscalationRule[] {
  if (existing.length > 0) return existing;
  return DEFAULT_ESCALATION_RULES.map((r, i) => ({
    id: `seed_${i}`,
    name: r.name,
    condition: r.condition,
    action: r.action,
    enabled: true,
    position: r.position,
  }));
}

function rowToRule(row: {
  id: string;
  name: string;
  conditionJson: unknown;
  action: string;
  enabled: boolean;
  position: number;
}): EscalationRule {
  const cond = (row.conditionJson ?? {}) as EscalationCondition;
  return {
    id: row.id,
    name: row.name,
    condition: { kind: cond.kind, ...(typeof cond.value === "number" ? { value: cond.value } : {}) },
    action: row.action === "notify" ? "notify" : "require_approval",
    enabled: row.enabled,
    position: row.position,
  };
}

/**
 * getOrSeedEscalationRules — DB-backed. Reads the workspace's rules;
 * on first read, seeds the 3 sensible defaults (persisted, user-editable).
 */
export async function getOrSeedEscalationRules(
  workspaceId: string,
): Promise<EscalationRule[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await tx.escalationRule.findMany({
      where: { workspaceId },
      orderBy: { position: "asc" },
      select: { id: true, name: true, conditionJson: true, action: true, enabled: true, position: true },
    });
    if (existing.length > 0) return existing.map(rowToRule);
    const created = await Promise.all(
      DEFAULT_ESCALATION_RULES.map((r) =>
        tx.escalationRule.create({
          data: {
            workspaceId,
            name: r.name,
            // Validated above: { kind, value? } is always JSON-serializable.
            conditionJson: r.condition as unknown as Prisma.InputJsonValue,
            action: r.action,
            position: r.position,
          },
          select: { id: true, name: true, conditionJson: true, action: true, enabled: true, position: true },
        }),
      ),
    );
    return created.map(rowToRule);
  });
}

/** Validate one rule payload for PUT /api/automation/rules. */
export function validateEscalationRule(
  rule: unknown,
): { ok: true; rule: { name: string; condition: EscalationCondition; action: EscalationEffect; enabled: boolean } } | { ok: false; error: string } {
  const r = rule as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return { ok: false, error: "Each rule must be an object." };
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name || name.length > 120) return { ok: false, error: "Rule name is required (max 120 chars)." };
  const cond = r.condition as Record<string, unknown> | null;
  const kind = cond?.kind;
  if (
    kind !== "amount_above" &&
    kind !== "unseen_treatment" &&
    kind !== "no_source_record" &&
    kind !== "external_audience"
  ) {
    return { ok: false, error: `Rule "${name}": condition.kind must be one of amount_above, unseen_treatment, no_source_record, external_audience.` };
  }
  let value: number | undefined;
  if (kind === "amount_above") {
    if (typeof cond?.value !== "number" || !Number.isInteger(cond.value) || cond.value < 0) {
      return { ok: false, error: `Rule "${name}": amount_above requires an integer value in cents.` };
    }
    value = cond.value;
  }
  const action = r.action;
  if (action !== "require_approval" && action !== "notify") {
    return { ok: false, error: `Rule "${name}": action must be require_approval or notify.` };
  }
  return {
    ok: true,
    rule: {
      name,
      condition: value === undefined ? { kind } : { kind, value },
      action,
      enabled: r.enabled !== false,
    },
  };
}
