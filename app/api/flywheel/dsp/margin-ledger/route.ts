// Marketr — /api/flywheel/dsp/margin-ledger
// Margin accounting ledger: client-billed spend, platform fees, passthroughs,
// and Marketr margin as DISTINCT lines — never commingled (editor+ POST).
// GET  → rows, ?period=YYYY-MM (viewer+), each row carries its reconciliation
// POST → post a derived row: media spend + the schedule live at the spend
//        period + the declared margin line. Body:
//        { period: "YYYY-MM", dsp, dspAdapterId, mediaSpendCents,
//          marketrMarginCents, note? }
//        platformFeesCents and passthroughCents are COMPUTED from fee-schedule
//        math (never hand-entered); clientBilled = fees + passthrough + margin.
//        The row pins the fee_schedule_version used.

import type { NextRequest } from "next/server";
import { dspGuard, badRequest, dspError, readJson } from "@/app/api/flywheel/dsp/_lib";
import { feeScheduleStore, marginLedgerStore, dspAdapterStore, dspAuditStore } from "@/app/api/flywheel/dsp/stores";
import { assertDspKind, postDerivedLedgerRow, reconcileLedgerRow } from "@/lib/flywheel/dsp";

export const dynamic = "force-dynamic";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(req: NextRequest) {
  const gate = await dspGuard("viewer");
  if (gate instanceof Response) return gate;
  const url = new URL(req.url);
  const period = url.searchParams.get("period") ?? undefined;
  if (period && !PERIOD_RE.test(period)) {
    return badRequest('period must be YYYY-MM, e.g. "2026-09".');
  }
  const rows = await marginLedgerStore().list(gate.workspaceId, period);
  return Response.json({
    zeroCustody: "The ledger accounts money; it never holds it. Billing stays with the agency/client.",
    rows: rows.map((r) => ({ ...r, reconciliation: reconcileLedgerRow(r) })),
  });
}

export async function POST(req: NextRequest) {
  const gate = await dspGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const body = await readJson(req);
    const period: unknown = body.period;
    const dsp: unknown = body.dsp;
    const dspAdapterId: unknown = body.dspAdapterId;
    const note: unknown = body.note;
    const mediaSpendCents: unknown = body.mediaSpendCents;
    const marketrMarginCents: unknown = body.marketrMarginCents;
    if (typeof period !== "string" || !PERIOD_RE.test(period)) {
      return badRequest('period is required as YYYY-MM, e.g. "2026-09".');
    }
    if (typeof dsp !== "string") return badRequest("dsp is required: one of ttd|dv360|amazon|basis.");
    assertDspKind(dsp);
    if (typeof dspAdapterId !== "string" || !dspAdapterId.trim()) {
      return badRequest("dspAdapterId is required.");
    }
    if (!Number.isInteger(mediaSpendCents) || (mediaSpendCents as number) < 0) {
      return badRequest("mediaSpendCents must be a non-negative integer (cents).");
    }
    if (!Number.isInteger(marketrMarginCents) || (marketrMarginCents as number) < 0) {
      return badRequest("marketrMarginCents must be a non-negative integer (cents).");
    }
    // The schedule live at the START of the spend period — not today's.
    const periodStart = new Date(`${period}-01T00:00:00Z`);
    const schedule = await feeScheduleStore().liveAt(gate.workspaceId, dsp, periodStart);
    if (!schedule) {
      return dspError(new Error(`No fee schedule was live for ${dsp} at ${period}. Publish one before posting.`));
    }
    const adapter = await dspAdapterStore().get(gate.workspaceId, dsp);
    if (!adapter || adapter.id !== dspAdapterId) {
      return badRequest("dspAdapterId does not match a DSP adapter in this workspace.");
    }
    const { row, feeMath } = await postDerivedLedgerRow(marginLedgerStore(), schedule, {
      workspaceId: gate.workspaceId,
      period,
      dspAdapterId,
      mediaSpendCents: mediaSpendCents as number,
      marketrMarginCents: marketrMarginCents as number,
      postedBy: gate.userId,
      note: typeof note === "string" ? note : undefined,
    });
    await dspAuditStore().log({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "ledger_posted",
      subjectType: "ledger_row", subjectId: row.id,
      detail: {
        period, dsp, feeScheduleVersion: schedule.version,
        clientBilledCents: row.clientBilledCents, platformFeesCents: row.platformFeesCents,
        passthroughCents: row.passthroughCents, marketrMarginCents: row.marketrMarginCents,
      },
    });
    return Response.json(
      { row: { ...row, reconciliation: reconcileLedgerRow(row) }, feeMath },
      { status: 201 },
    );
  } catch (err) {
    return dspError(err);
  }
}
