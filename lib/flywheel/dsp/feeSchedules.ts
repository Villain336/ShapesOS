// Marketr — Phase 7 F5: versioned fee-schedule registry.
//
// Per-DSP fee lines (take rates, tech fees, minimums) versioned over time so
// margin math is auditable against the schedule that was live WHEN THE SPEND
// HAPPENED — never against today's schedule retroactively.

import { DspKind, DSP_KINDS, assertDspKind } from "./types";

export interface FeeLines {
  /** Platform take rate, basis points (e.g. 1500 = 15%). */
  takeRateBps: number;
  /** Tech/data fee, basis points. */
  techFeeBps: number;
  /** Flat monthly seat/tech minimum, cents. */
  monthlyMinimumCents: number;
  /** One-time onboarding/implementation, cents (0 = none). */
  onboardingCents?: number;
  /** Free-text provenance for the numbers (e.g. "TTD 2026 partner rate card"). */
  sourceNote?: string;
}

export interface FeeSchedule {
  id: string;
  workspaceId: string;
  dsp: DspKind;
  version: number;
  feeLines: FeeLines;
  effectiveFrom: Date;
  createdBy: string;
  createdAt: Date;
}

export interface FeeScheduleStore {
  /** Publish a new version. Version numbers must strictly increase. */
  publish(input: Omit<FeeSchedule, "id" | "createdAt">): Promise<FeeSchedule>;
  /** Schedule that was live for `dsp` at time `at` (the whole point). */
  liveAt(workspaceId: string, dsp: DspKind, at: Date): Promise<FeeSchedule | null>;
  /** All versions for a dsp, newest first. */
  history(workspaceId: string, dsp: DspKind): Promise<FeeSchedule[]>;
  list(workspaceId: string): Promise<FeeSchedule[]>;
}

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function validateFeeLines(lines: FeeLines): void {
  const problems: string[] = [];
  if (!Number.isFinite(lines.takeRateBps) || lines.takeRateBps < 0 || lines.takeRateBps > 10000) {
    problems.push("takeRateBps must be 0–10000 bps");
  }
  if (!Number.isFinite(lines.techFeeBps) || lines.techFeeBps < 0 || lines.techFeeBps > 10000) {
    problems.push("techFeeBps must be 0–10000 bps");
  }
  if (!Number.isInteger(lines.monthlyMinimumCents) || lines.monthlyMinimumCents < 0) {
    problems.push("monthlyMinimumCents must be a non-negative integer cents");
  }
  if (lines.onboardingCents !== undefined && (!Number.isInteger(lines.onboardingCents) || lines.onboardingCents < 0)) {
    problems.push("onboardingCents must be a non-negative integer cents");
  }
  if (problems.length) throw new Error(`Invalid fee lines: ${problems.join("; ")}.`);
}

export function createMemoryFeeScheduleStore(): FeeScheduleStore {
  const rows: FeeSchedule[] = [];
  return {
    async publish(input) {
      assertDspKind(input.dsp);
      validateFeeLines(input.feeLines);
      const prior = rows
        .filter((r) => r.workspaceId === input.workspaceId && r.dsp === input.dsp)
        .sort((a, b) => b.version - a.version)[0];
      const expected = (prior?.version ?? 0) + 1;
      if (input.version !== expected) {
        throw new Error(
          `Fee schedule version must be ${expected} (next after ${prior?.version ?? "none"}), got ${input.version}. Versions are append-only.`,
        );
      }
      const row: FeeSchedule = { ...input, id: uid("fees"), createdAt: new Date() };
      rows.push(row);
      return { ...row };
    },
    async liveAt(workspaceId, dsp, at) {
      const candidates = rows
        .filter((r) => r.workspaceId === workspaceId && r.dsp === dsp && r.effectiveFrom <= at)
        .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
      return candidates[0] ? { ...candidates[0] } : null;
    },
    async history(workspaceId, dsp) {
      return rows
        .filter((r) => r.workspaceId === workspaceId && r.dsp === dsp)
        .sort((a, b) => b.version - a.version)
        .map((r) => ({ ...r }));
    },
    async list(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId).map((r) => ({ ...r }));
    },
  };
}

export interface FeeMath {
  spendCents: number;
  scheduleVersion: number;
  scheduleEffectiveFrom: Date;
  takeRateCents: number;
  techFeeCents: number;
  monthlyMinimumCents: number;
  /** What the DSP line item costs the agency: max(media spend + fees, monthly minimum). */
  platformCostCents: number;
}

/** Fee math against a SPECIFIC schedule (the one live at the spend period).
 *  The returned scheduleVersion pins the audit. */
export function computeFeeMath(spendCents: number, schedule: FeeSchedule): FeeMath {
  if (!Number.isInteger(spendCents) || spendCents < 0) {
    throw new Error("spendCents must be a non-negative integer.");
  }
  const takeRateCents = Math.round((spendCents * schedule.feeLines.takeRateBps) / 10000);
  const techFeeCents = Math.round((spendCents * schedule.feeLines.techFeeBps) / 10000);
  const mediaPlusFees = spendCents + takeRateCents + techFeeCents;
  const platformCostCents = Math.max(mediaPlusFees, schedule.feeLines.monthlyMinimumCents);
  return {
    spendCents,
    scheduleVersion: schedule.version,
    scheduleEffectiveFrom: schedule.effectiveFrom,
    takeRateCents,
    techFeeCents,
    monthlyMinimumCents: schedule.feeLines.monthlyMinimumCents,
    platformCostCents,
  };
}

/** All four DSPs ship with realistic placeholder v1 schedules (marked as such). */
export const PLACEHOLDER_SOURCE = "placeholder v1 — replace with your agency's signed rate card";

export function placeholderFeeLines(): Record<DspKind, FeeLines> {
  return {
    // Partner-routed: markup on media (illustrative, not a quote).
    ttd: { takeRateBps: 1500, techFeeBps: 200, monthlyMinimumCents: 0, sourceNote: PLACEHOLDER_SOURCE },
    dv360: { takeRateBps: 1000, techFeeBps: 300, monthlyMinimumCents: 0, sourceNote: PLACEHOLDER_SOURCE },
    amazon: { takeRateBps: 1200, techFeeBps: 100, monthlyMinimumCents: 0, sourceNote: PLACEHOLDER_SOURCE },
    basis: { takeRateBps: 1200, techFeeBps: 150, monthlyMinimumCents: 0, sourceNote: PLACEHOLDER_SOURCE },
  };
}

export async function seedPlaceholderSchedules(
  store: FeeScheduleStore,
  workspaceId: string,
  createdBy: string,
  effectiveFrom: Date,
): Promise<FeeSchedule[]> {
  const lines = placeholderFeeLines();
  return Promise.all(
    DSP_KINDS.map((dsp) =>
      store.publish({ workspaceId, dsp, version: 1, feeLines: lines[dsp], effectiveFrom, createdBy }),
    ),
  );
}
