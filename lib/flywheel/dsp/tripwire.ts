// Marketr — Phase 7 F5: volume tripwire decision tree (productized judgment).
//
// Aggregate monthly media spend → a rail recommendation, with the fee-schedule
// math behind it. Bands (SPEC-PHASE7 §2/F5):
//   <$20K/mo        → no DSP (not enough volume to amortize the fixed costs)
//   $20–50K/mo     → self-serve rails (StackAdapt, Amazon self-service)
//   $50–250K/mo    → managed tier (DV360 reseller, Amazon agency seat, TTD partner-routed)
//   >$250K/mo sustained → direct TTD seat (saved partner markup beats seat fixed costs)
//   >$500K/mo      → multi-DSP (Phase 8+ problem)
//
// The tripwire report is an AUDITED recommendation: every number traces to a
// pinned fee-schedule version. It never executes — the human decides.

import { DspKind } from "./types";
import { FeeSchedule, computeFeeMath, FeeMath } from "./feeSchedules";

export type TripwireBand =
  | "no_dsp"
  | "self_serve"
  | "managed_tier"
  | "direct_ttd_seat"
  | "multi_dsp";

export const BAND_LABELS: Record<TripwireBand, string> = {
  no_dsp: "No DSP — stay on platform-native buying",
  self_serve: "Self-serve rails (StackAdapt, Amazon self-service)",
  managed_tier: "Managed tier (DV360 reseller, Amazon agency seat, TTD partner-routed)",
  direct_ttd_seat: "Direct TTD seat",
  multi_dsp: "Multi-DSP (Phase 8+ planning)",
};

export interface TripwireInput {
  aggregateMonthlySpendCents: number;
  /** The direct-seat break-even argument needs a sustained history. */
  sustainedMonthsAbove250k?: number;
  /** Monthly fee math per candidate dsp, audited against pinned schedules. */
  feeMaths: Array<{ dsp: DspKind; math: FeeMath }>;
}

export interface RailCosting {
  rail: string;
  band: TripwireBand;
  /** Effective monthly cost at this spend: media + fees + fixed seat costs. */
  effectiveMonthlyCents: number;
  /** Fixed monthly seat/platform costs assumed (cents). */
  fixedMonthlyCents: number;
  /** Notes, including the fee-schedule version each figure pins to. */
  mathNotes: string[];
}

export interface TripwireReport {
  generatedAt: Date;
  workspaceId: string;
  aggregateMonthlySpendCents: number;
  band: TripwireBand;
  bandLabel: string;
  recommendation: string;
  railCostings: RailCosting[];
  /** The direct-seat break-even: saved partner markup vs seat fixed costs. */
  seatBreakeven: {
    partnerMarkupSavedBps: number;
    savedMarkupCents: number;
    seatFixedMonthlyCents: number;
    directSeatWins: boolean;
  } | null;
  sustainedNote: string;
  feeSchedulePins: Array<{ dsp: DspKind; version: number; effectiveFrom: string }>;
  decisionRequiredByHuman: true;
}

export function tripwireBandFor(spendCents: number, sustainedMonthsAbove250k = 0): TripwireBand {
  const k = spendCents / 100 / 1000; // $K
  if (k < 20) return "no_dsp";
  if (k < 50) return "self_serve";
  if (k < 250) return "managed_tier";
  if (k < 500) return sustainedMonthsAbove250k >= 3 ? "direct_ttd_seat" : "managed_tier";
  return "multi_dsp";
}

// Direct-seat fixed costs (illustrative monthly, cents): platform seat minimums
// + managed overhead the agency would carry itself. Kept conservative.
const SEAT_FIXED_MONTHLY_CENTS: Record<DspKind, number> = {
  ttd: 1_000_000, // ~$10K/mo all-in fixed (minimums + ops) — illustrative
  dv360: 500_000,
  amazon: 300_000,
  basis: 300_000,
};

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export function buildTripwireReport(
  workspaceId: string,
  input: TripwireInput,
  now: Date = new Date(),
): TripwireReport {
  const { aggregateMonthlySpendCents: spend, sustainedMonthsAbove250k = 0 } = input;
  if (!Number.isInteger(spend) || spend < 0) {
    throw new Error("aggregateMonthlySpendCents must be a non-negative integer.");
  }
  const band = tripwireBandFor(spend, sustainedMonthsAbove250k);

  const railCostings: RailCosting[] = input.feeMaths.map(({ dsp, math }) => {
    const fixed = SEAT_FIXED_MONTHLY_CENTS[dsp];
    const effectiveMonthlyCents = math.platformCostCents + fixed;
    return {
      rail: dsp,
      band,
      effectiveMonthlyCents,
      fixedMonthlyCents: fixed,
      mathNotes: [
        `Media ${money(math.spendCents)} + take ${money(math.takeRateCents)} + tech ${money(math.techFeeCents)}`,
        `Platform cost ${money(math.platformCostCents)} (minimums applied)`,
        `Assumed seat fixed ${money(fixed)}/mo (illustrative)`,
        `Fee math pins fee-schedule ${dsp} v${math.scheduleVersion} (effective ${math.scheduleEffectiveFrom.toISOString().slice(0, 10)})`,
      ],
    };
  });

  // Direct seat beats partner when saved partner markup exceeds seat fixed costs.
  let seatBreakeven: TripwireReport["seatBreakeven"] = null;
  if (band === "direct_ttd_seat" || band === "multi_dsp" || band === "managed_tier") {
    const partnerMarkupSavedBps = 1500; // 15 pts: the mid of the 10–20 pt band
    const savedMarkupCents = Math.round((spend * partnerMarkupSavedBps) / 10000);
    const seatFixedMonthlyCents = SEAT_FIXED_MONTHLY_CENTS.ttd;
    seatBreakeven = {
      partnerMarkupSavedBps,
      savedMarkupCents,
      seatFixedMonthlyCents,
      directSeatWins: savedMarkupCents > seatFixedMonthlyCents,
    };
  }

  const sustainedNote =
    band === "managed_tier" && spend / 100 >= 250_000
      ? `Spend is above $250K/mo but only ${sustainedMonthsAbove250k} sustained month(s) — a direct seat ` +
        `unlocks after 3 sustained months. Stay partner-routed until then.`
      : band === "direct_ttd_seat"
        ? `${sustainedMonthsAbove250k} sustained months above $250K — the volume justifies a direct seat commitment.`
        : "";

  const recommendation =
    band === "no_dsp"
      ? `At ${money(spend)}/mo, no DSP: fixed seat costs would exceed any markup saved. Keep platform-native buying; re-run the tripwire as volume grows.`
      : band === "self_serve"
        ? `At ${money(spend)}/mo: self-serve rails (StackAdapt, Amazon self-service) — no seat contracts, fees stay variable.`
        : band === "managed_tier"
          ? `At ${money(spend)}/mo: managed tier — DV360 reseller, Amazon agency seat, or TTD partner-routed. Partner markup (10–20 pts) is cheaper than a direct seat's fixed costs at this volume.`
          : band === "direct_ttd_seat"
            ? `At ${money(spend)}/mo sustained: a direct TTD seat. Saved partner markup (~${money(seatBreakeven!.savedMarkupCents)}/mo) exceeds the seat's fixed costs (~${money(seatBreakeven!.seatFixedMonthlyCents)}/mo).`
            : `At ${money(spend)}/mo: multi-DSP planning (Phase 8+) — run a direct-seat RFP across TTD/DV360/Amazon.`;

  return {
    generatedAt: now,
    workspaceId,
    aggregateMonthlySpendCents: spend,
    band,
    bandLabel: BAND_LABELS[band],
    recommendation,
    railCostings,
    seatBreakeven,
    sustainedNote,
    feeSchedulePins: input.feeMaths.map(({ dsp, math }) => ({
      dsp,
      version: math.scheduleVersion,
      effectiveFrom: math.scheduleEffectiveFrom.toISOString(),
    })),
    decisionRequiredByHuman: true,
  };
}

/** Convenience: compute fee maths for every candidate dsp from live schedules. */
export async function feeMathsForTripwire(
  spendCents: number,
  liveSchedules: FeeSchedule[],
): Promise<Array<{ dsp: DspKind; math: FeeMath }>> {
  return liveSchedules.map((schedule) => ({ dsp: schedule.dsp, math: computeFeeMath(spendCents, schedule) }));
}

/** Seed helper: live schedules for all four DSPs at `at` (from a store). */
export async function liveSchedulesFor(
  store: { liveAt(workspaceId: string, dsp: DspKind, at: Date): Promise<FeeSchedule | null> },
  workspaceId: string,
  at: Date,
): Promise<FeeSchedule[]> {
  const out: FeeSchedule[] = [];
  for (const dsp of ["ttd", "dv360", "amazon", "basis"] as DspKind[]) {
    const s = await store.liveAt(workspaceId, dsp, at);
    if (s) out.push(s);
  }
  if (!out.length) throw new Error("No live fee schedules — seed fee schedules before running the tripwire.");
  return out;
}
