// Marketr — Legal/Compliance slice 2: deadline escalation sweep.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4 (deadline engine).
//
// The sweep computes the escalation tier for every open deadline in a
// workspace and emits through the alert hub (lib/alerts/evaluate.ts) when a
// deadline enters a NEW tier — escalation tiers produce alerts at increasing
// severity, and each tier fires at most once per deadline (recorded on
// lastAlertedTier), so tenants get the 90 → 30 → 7 → overdue ladder without
// a daily nag for the same tier.
//
// This module takes its store and emitter as arguments: the cron route wires
// PrismaLegalStore + emitAlert, tests inject fakes. Nothing here invents
// dates — every emitted alert is grounded in a tenant-set date, a date
// computed from one via nextDueDate(), or the explicit "date needed" state.

import type { TriggerInput } from "@/lib/alerts/evaluate";
import { LEGAL_DISCLAIMER } from "./types";
import {
  TIER_META,
  daysUntilDue,
  tierAlertBody,
  tierAlertTitle,
  tierForDeadline,
  type EscalationTier,
} from "./deadlines";

export interface SweepDeadline {
  id: string;
  templateKey: string;
  title: string;
  dueDate: Date | null;
  source: "tenant_set" | "computed";
  /** Tier already alerted for, if any — the sweep only fires on change. */
  lastAlertedTier: EscalationTier | null;
}

/** Minimal store surface the sweep needs (PrismaLegalStore implements it). */
export interface DeadlineSweepStore {
  listOpenDeadlines(workspaceId: string): Promise<SweepDeadline[]>;
  recordAlertedTier(
    workspaceId: string,
    deadlineId: string,
    tier: EscalationTier,
    now: Date,
  ): Promise<void>;
}

export type DeadlineEmitter = (input: TriggerInput) => Promise<unknown>;

export interface SweepOptions {
  now?: Date;
  /** Dashboard-relative deep link for the alert. */
  link?: string;
}

export interface SweepResult {
  workspaceId: string;
  checked: number;
  emitted: number;
  skipped: number;
  /** deadlineId → tier that was emitted. */
  fired: { deadlineId: string; title: string; tier: EscalationTier }[];
}

function formatDateUtc(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Run one workspace's escalation sweep. Emits at most one alert per deadline
 * per tier transition; never emits for a tier already recorded.
 */
export async function sweepLegalDeadlineAlerts(
  store: DeadlineSweepStore,
  emit: DeadlineEmitter,
  workspaceId: string,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const deadlines = await store.listOpenDeadlines(workspaceId);

  let emitted = 0;
  let skipped = 0;
  const fired: SweepResult["fired"] = [];

  for (const d of deadlines) {
    const tier = tierForDeadline(d.dueDate, now);
    if (tier === null) {
      skipped += 1;
      continue;
    }
    // Same tier already alerted — only fire on escalation (tier change).
    if (d.lastAlertedTier === tier) {
      skipped += 1;
      continue;
    }

    const days = d.dueDate ? daysUntilDue(d.dueDate, now) : null;
    const body =
      tierAlertBody({
        title: d.title,
        tier,
        dueDateText: d.dueDate ? formatDateUtc(d.dueDate) : null,
        daysUntil: days,
      }) + `\n\n${LEGAL_DISCLAIMER}`;

    await emit({
      workspaceId,
      trigger: "legal_deadline",
      severity: TIER_META[tier].severity,
      title: tierAlertTitle(d.title, tier),
      body,
      link: opts.link ?? "/dashboard/legal",
      dedupKey: `legal_deadline:${d.id}:${tier}`,
      scopeKeywordIds: [],
    });
    await store.recordAlertedTier(workspaceId, d.id, tier, now);
    emitted += 1;
    fired.push({ deadlineId: d.id, title: d.title, tier });
  }

  return {
    workspaceId,
    checked: deadlines.length,
    emitted,
    skipped,
    fired,
  };
}
