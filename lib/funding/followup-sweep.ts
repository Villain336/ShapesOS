// Marketr — Funding/VC slice 2: follow-up reminder sweep.
//
// The sweep computes the escalation tier for every OPEN follow-up in a
// workspace and emits through the alert hub (lib/alerts/evaluate.ts) when a
// follow-up enters a NEW tier — each tier fires at most once per follow-up
// (recorded on lastAlertedTier), so tenants get the upcoming → due-today →
// overdue ladder without a daily nag for the same tier.
//
// This module takes its store and emitter as arguments: the cron route wires
// PrismaFundingStore + emitAlert, tests inject fakes. Every emitted alert is
// grounded in a tenant-set due date — nothing here invents dates.

import type { TriggerInput } from "@/lib/alerts/evaluate";

export type FollowUpTier = "upcoming" | "due_today" | "overdue";

export const FOLLOWUP_TIER_META: Record<
  FollowUpTier,
  { severity: "info" | "warn" | "critical"; label: string }
> = {
  upcoming: { severity: "info", label: "Upcoming" },
  due_today: { severity: "warn", label: "Due today" },
  overdue: { severity: "critical", label: "Overdue" },
};

const UPCOMING_WINDOW_DAYS = 7;

export interface SweepFollowUp {
  id: string;
  investorId: string;
  investorName: string;
  dueAt: Date;
  note: string;
  /** Tier already alerted for, if any — the sweep only fires on change. */
  lastAlertedTier: string | null;
}

/** Minimal store surface the sweep needs (PrismaFundingStore implements it). */
export interface FollowUpSweepStore {
  listOpenFollowUps(workspaceId: string): Promise<SweepFollowUp[]>;
  recordFollowUpAlertedTier(
    workspaceId: string,
    followUpId: string,
    tier: string,
  ): Promise<void>;
}

export type FollowUpEmitter = (input: TriggerInput) => Promise<unknown>;

export interface FollowUpSweepOptions {
  now?: Date;
  /** Dashboard-relative deep link for the alert. */
  link?: string;
}

export interface FollowUpSweepResult {
  workspaceId: string;
  checked: number;
  emitted: number;
  skipped: number;
  fired: { followUpId: string; investorName: string; tier: FollowUpTier }[];
}

function startOfDayUtc(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The tier for a due date, or null when it is too far out to alert. */
export function tierForFollowUp(dueAt: Date, now: Date): FollowUpTier | null {
  const dayDiff =
    (startOfDayUtc(dueAt) - startOfDayUtc(now)) / (24 * 60 * 60 * 1000);
  if (dayDiff < 0) return "overdue";
  if (dayDiff === 0) return "due_today";
  if (dayDiff <= UPCOMING_WINDOW_DAYS) return "upcoming";
  return null;
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
 * Run one workspace's follow-up sweep. Emits at most one alert per follow-up
 * per tier transition; never emits for a tier already recorded.
 */
export async function sweepFundingFollowUpAlerts(
  store: FollowUpSweepStore,
  emit: FollowUpEmitter,
  workspaceId: string,
  opts: FollowUpSweepOptions = {},
): Promise<FollowUpSweepResult> {
  const now = opts.now ?? new Date();
  const followUps = await store.listOpenFollowUps(workspaceId);

  let emitted = 0;
  let skipped = 0;
  const fired: FollowUpSweepResult["fired"] = [];

  for (const f of followUps) {
    const tier = tierForFollowUp(f.dueAt, now);
    if (tier === null) {
      skipped += 1;
      continue;
    }
    // Same tier already alerted — only fire on escalation (tier change).
    if (f.lastAlertedTier === tier) {
      skipped += 1;
      continue;
    }

    const meta = FOLLOWUP_TIER_META[tier];
    const title = `Follow-up ${meta.label.toLowerCase()}: ${f.investorName}`;
    const body = [
      `${f.investorName}: ${f.note}`,
      `Due ${formatDateUtc(f.dueAt)} — ${meta.label}.`,
    ].join("\n");

    await emit({
      workspaceId,
      trigger: "funding_followup",
      severity: meta.severity,
      title,
      body,
      link: opts.link ?? `/dashboard/funding?investor=${f.investorId}`,
      dedupKey: `funding_followup:${f.id}:${tier}`,
      scopeKeywordIds: [],
    });
    await store.recordFollowUpAlertedTier(workspaceId, f.id, tier);
    emitted += 1;
    fired.push({ followUpId: f.id, investorName: f.investorName, tier });
  }

  return {
    workspaceId,
    checked: followUps.length,
    emitted,
    skipped,
    fired,
  };
}
