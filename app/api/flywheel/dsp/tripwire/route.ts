// Marketr — GET /api/flywheel/dsp/tripwire
// Volume tripwire decision tree: aggregate monthly spend → rail recommendation
// with the fee-schedule math behind it (viewer+).
// Query: ?spendCents=…&sustainedMonthsAbove250k=…
// Every figure pins the fee-schedule version it was computed against. The
// report recommends; it never executes — the human decides.

import type { NextRequest } from "next/server";import { dspGuard, badRequest, dspError } from "@/app/api/flywheel/dsp/_lib";
import { feeScheduleStore, dspAuditStore } from "@/app/api/flywheel/dsp/stores";
import {
  buildTripwireReport,
  feeMathsForTripwire,
  liveSchedulesFor,
  seedPlaceholderSchedules,
  ZERO_CUSTODY_COPY,
} from "@/lib/flywheel/dsp";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await dspGuard("viewer");
  if (gate instanceof Response) return gate;
  try {
    const url = new URL(req.url);
    const spendCents = Number(url.searchParams.get("spendCents") ?? "0");
    const sustainedMonthsAbove250k = Number(url.searchParams.get("sustainedMonthsAbove250k") ?? "0");
    if (!Number.isInteger(spendCents) || spendCents < 0) {
      return badRequest("spendCents must be a non-negative integer (cents).");
    }
    if (!Number.isInteger(sustainedMonthsAbove250k) || sustainedMonthsAbove250k < 0) {
      return badRequest("sustainedMonthsAbove250k must be a non-negative integer.");
    }
    const store = feeScheduleStore();
    let live = await liveSchedulesFor(store, gate.workspaceId, new Date()).catch(() => []);
    if (!live.length) {
      // Seed placeholder v1 schedules so the tripwire always shows auditable math.
      live = await seedPlaceholderSchedules(store, gate.workspaceId, "system", new Date("2026-01-01"));
      await dspAuditStore().log({
        workspaceId: gate.workspaceId, actor: "system", action: "fee_schedule_versioned",
        subjectType: "fee_schedule", detail: { seeded: "placeholder v1 ×4" },
      });
    }
    const feeMaths = await feeMathsForTripwire(spendCents, live);
    const report = buildTripwireReport(
      gate.workspaceId,
      { aggregateMonthlySpendCents: spendCents, sustainedMonthsAbove250k, feeMaths },
    );
    await dspAuditStore().log({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "tripwire_report",
      subjectType: "tripwire",
      detail: {
        spendCents, band: report.band, pins: report.feeSchedulePins,
        decisionRequiredByHuman: true,
      },
    });
    return Response.json({ ...report, zeroCustody: ZERO_CUSTODY_COPY });
  } catch (err) {
    return dspError(err);
  }
}
