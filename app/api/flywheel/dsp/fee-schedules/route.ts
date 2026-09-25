// Marketr — /api/flywheel/dsp/fee-schedules
// Versioned fee-schedule registry (SPEC-PHASE7 §4: fee_schedules).
// GET  → list all versions, newest first (viewer+)
// POST → publish a new version (editor+). Versions are append-only and
//        strictly increasing; margin math always pins the schedule live at
//        the spend time — never today's schedule retroactively.
// Body: { dsp: "ttd"|"dv360"|"amazon"|"basis", feeLines: { takeRateBps, techFeeBps, monthlyMinimumCents, onboardingCents?, sourceNote? }, effectiveFrom: ISO }

import type { NextRequest } from "next/server";
import { dspGuard, badRequest, dspError, readJson } from "@/app/api/flywheel/dsp/_lib";
import { feeScheduleStore, dspAuditStore } from "@/app/api/flywheel/dsp/stores";
import { assertDspKind } from "@/lib/flywheel/dsp";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await dspGuard("viewer");
  if (gate instanceof Response) return gate;
  const schedules = await feeScheduleStore().list(gate.workspaceId);
  return Response.json({
    schedules: schedules.map((s) => ({
      id: s.id, dsp: s.dsp, version: s.version,
      feeLines: s.feeLines, effectiveFrom: s.effectiveFrom,
      createdBy: s.createdBy, createdAt: s.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const gate = await dspGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const body = await readJson(req);
    const dsp = body.dsp;
    if (typeof dsp !== "string") return badRequest('dsp is required: one of ttd|dv360|amazon|basis.');
    assertDspKind(dsp);
    const feeLines = body.feeLines as Record<string, unknown> | null;
    if (typeof feeLines !== "object" || feeLines === null) {
      return badRequest("feeLines is required: { takeRateBps, techFeeBps, monthlyMinimumCents, onboardingCents?, sourceNote? }.");
    }
    const effectiveFrom = body.effectiveFrom ? new Date(String(body.effectiveFrom)) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) return badRequest("effectiveFrom must be a valid ISO date.");
    const history = await feeScheduleStore().history(gate.workspaceId, dsp);
    const version = (history[0]?.version ?? 0) + 1;
    const schedule = await feeScheduleStore().publish({
      workspaceId: gate.workspaceId,
      dsp,
      version,
      feeLines: {
        takeRateBps: Number(feeLines.takeRateBps),
        techFeeBps: Number(feeLines.techFeeBps),
        monthlyMinimumCents: Number(feeLines.monthlyMinimumCents),
        onboardingCents: feeLines.onboardingCents !== undefined ? Number(feeLines.onboardingCents) : undefined,
        sourceNote: feeLines.sourceNote !== undefined ? String(feeLines.sourceNote) : undefined,
      },
      effectiveFrom,
      createdBy: gate.userId,
    });
    await dspAuditStore().log({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "fee_schedule_versioned",
      subjectType: "fee_schedule", subjectId: schedule.id,
      detail: { dsp, version, effectiveFrom: effectiveFrom.toISOString() },
    });
    return Response.json({ schedule }, { status: 201 });
  } catch (err) {
    return dspError(err);
  }
}
