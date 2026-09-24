// Marketr — Lead Pipeline CRM: the active-lead meter.
//
// The natural meter for the CRM (AGENCY-COMPARISON.md R1, MASTER-PLAN.md
// Phase 1): count of ACTIVE leads per workspace — leads whose stage is not
// closed (Won/Lost). This is exposed as a usage *dimension* for plan limits
// and the Phase 2 attribution work; it is NOT a credit charge action. No
// meter() call is made here — additive, read-only, zero billing behavior
// change. Documented in lib/metering/SEAM.md ("crm_active_leads").

import { prisma } from "@/lib/prisma";
import { CLOSED_STAGES } from "./stages";

/** Active (non-closed) lead count for a workspace. Tenant-scoped. */
export async function getActiveLeadCount(workspaceId: string): Promise<number> {
  return prisma.lead.count({
    where: {
      workspaceId,
      NOT: { stage: { in: [...CLOSED_STAGES] } },
    },
  });
}

/** Active lead counts per pipeline (for the CRM status bar + plan-limit UX). */
export async function getActiveLeadCountByPipeline(
  workspaceId: string,
): Promise<Record<string, number>> {
  const rows = await prisma.lead.groupBy({
    by: ["pipelineId"],
    where: { workspaceId, NOT: { stage: { in: [...CLOSED_STAGES] } } },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.pipelineId, r._count._all]));
}
