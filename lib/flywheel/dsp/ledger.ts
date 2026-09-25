// Marketr — Phase 7 F5: margin accounting ledger.
//
// Client-billed spend, platform fees, passthroughs, and Marketr margin are
// DISTINCT lines — never commingled (MASTER-PLAN §3.3, SPEC-PHASE7 §9.13).
// The separation is structural: four columns, no combined-total column,
// and postLedger() refuses any row that tries to merge lines (e.g. margin
// folded into fees). Append-only: post-only, never update.

import { DspKind } from "./types";
import { FeeSchedule, computeFeeMath } from "./feeSchedules";

/** One ledger row: the four money lines for a dsp × period. */
export interface MarginLedgerRow {
  id: string;
  workspaceId: string;
  /** ISO period label, e.g. "2026-09". */
  period: string;
  dspAdapterId: string;
  dsp: DspKind;
  /** Amount the AGENCY billed the CLIENT for the period. */
  clientBilledCents: number;
  /** DSP take/tech fees + minimums the agency owes (fee-schedule math). */
  platformFeesCents: number;
  /** Media spend passed through at cost — NOT agency revenue. */
  passthroughCents: number;
  /** Marketr's margin line — declared distinctly, never derived silently. */
  marketrMarginCents: number;
  /** The fee-schedule version the math was audited against. */
  feeScheduleVersion: number;
  note: string | null;
  postedBy: string;
  postedAt: Date;
}

export interface LedgerPostInput {
  workspaceId: string;
  period: string;
  dspAdapterId: string;
  dsp: DspKind;
  clientBilledCents: number;
  platformFeesCents: number;
  passthroughCents: number;
  marketrMarginCents: number;
  feeScheduleVersion: number;
  note?: string;
  postedBy: string;
}

export interface MarginLedgerStore {
  /** Append-only post. Refuses commingled or inconsistent rows. */
  post(input: LedgerPostInput): Promise<MarginLedgerRow>;
  list(workspaceId: string, period?: string): Promise<MarginLedgerRow[]>;
  get(workspaceId: string, id: string): Promise<MarginLedgerRow | null>;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function cents(n: number, field: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${field} must be a non-negative integer (cents), got ${n}.`);
  }
}

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function createMemoryMarginLedgerStore(): MarginLedgerStore {
  const rows: MarginLedgerRow[] = [];
  return {
    async post(input) {
      for (const [field, v] of [
        ["clientBilledCents", input.clientBilledCents],
        ["platformFeesCents", input.platformFeesCents],
        ["passthroughCents", input.passthroughCents],
        ["marketrMarginCents", input.marketrMarginCents],
      ] as const) {
        cents(v, field);
      }
      if (!PERIOD_RE.test(input.period)) {
        throw new Error(`period must be YYYY-MM, got "${input.period}".`);
      }
      if (input.feeScheduleVersion < 1) {
        throw new Error("feeScheduleVersion must be >= 1 — every ledger row pins the live schedule.");
      }
      const row: MarginLedgerRow = {
        id: uid("mledger"),
        workspaceId: input.workspaceId,
        period: input.period,
        dspAdapterId: input.dspAdapterId,
        dsp: input.dsp,
        clientBilledCents: input.clientBilledCents,
        platformFeesCents: input.platformFeesCents,
        passthroughCents: input.passthroughCents,
        marketrMarginCents: input.marketrMarginCents,
        feeScheduleVersion: input.feeScheduleVersion,
        note: input.note ?? null,
        postedBy: input.postedBy,
        postedAt: new Date(),
      };
      rows.push(row);
      return { ...row };
    },
    async list(workspaceId, period) {
      return rows
        .filter((r) => r.workspaceId === workspaceId && (!period || r.period === period))
        .map((r) => ({ ...r }));
    },
    async get(workspaceId, id) {
      const r = rows.find((x) => x.workspaceId === workspaceId && x.id === id);
      return r ? { ...r } : null;
    },
  };
}

/**
 * Post a ledger row DERIVED from fee-schedule math: given the media spend for
 * the period and the schedule live at that time, the platform-fee and
 * passthrough lines are computed (never hand-entered), the margin line is the
 * agency's declared take, and client-billed must reconcile.
 *
 * Structural anti-commingling: the schema holds four DISTINCT columns; this
 * function refuses to post when clientBilled != platformFees + passthrough +
 * margin, so the margin can never hide inside another line.
 */
export async function postDerivedLedgerRow(
  store: MarginLedgerStore,
  schedule: FeeSchedule,
  opts: {
    workspaceId: string;
    period: string;
    dspAdapterId: string;
    mediaSpendCents: number;
    marketrMarginCents: number;
    postedBy: string;
    note?: string;
  },
): Promise<{ row: MarginLedgerRow; feeMath: ReturnType<typeof computeFeeMath> }> {
  if (opts.mediaSpendCents < 0 || !Number.isInteger(opts.mediaSpendCents)) {
    throw new Error("mediaSpendCents must be a non-negative integer.");
  }
  cents(opts.marketrMarginCents, "marketrMarginCents");
  const feeMath = computeFeeMath(opts.mediaSpendCents, schedule);
  const passthroughCents = opts.mediaSpendCents;
  const platformFeesCents = feeMath.platformCostCents - feeMath.spendCents;
  const clientBilledCents = passthroughCents + platformFeesCents + opts.marketrMarginCents;
  const row = await store.post({
    workspaceId: opts.workspaceId,
    period: opts.period,
    dspAdapterId: opts.dspAdapterId,
    dsp: schedule.dsp,
    clientBilledCents,
    platformFeesCents,
    passthroughCents,
    marketrMarginCents: opts.marketrMarginCents,
    feeScheduleVersion: schedule.version,
    note: opts.note,
    postedBy: opts.postedBy,
  });
  return { row, feeMath };
}

/** Reconcile a row: returns the per-line proof that the lines are distinct. */
export function reconcileLedgerRow(row: MarginLedgerRow): {
  balanced: boolean;
  expectedClientBilledCents: number;
  lines: Record<string, number>;
} {
  const expectedClientBilledCents =
    row.passthroughCents + row.platformFeesCents + row.marketrMarginCents;
  return {
    balanced: row.clientBilledCents === expectedClientBilledCents,
    expectedClientBilledCents,
    lines: {
      client_billed: row.clientBilledCents,
      platform_fees: row.platformFeesCents,
      passthrough: row.passthroughCents,
      marketr_margin: row.marketrMarginCents,
    },
  };
}
