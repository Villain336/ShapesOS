// Marketr — GET /api/flywheel/recycling/briefs/[id]
// The brief with its creative-hash lineage, a lineage-integrity verdict, the
// studio routing receipts, and the audit trail.

import type { NextRequest } from "next/server";
import { recyclingGuard, notProvisioned, recyclingError } from "../../_lib";
import {
  recyclingTablesReady, prismaRecyclingBriefStore, prismaRecyclingAuditStore,
} from "@/lib/flywheel/recycling/db";
import { verifyLineage } from "@/lib/flywheel/recycling/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const gate = await recyclingGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await recyclingTablesReady())) return notProvisioned();

  const { id } = await params;
  try {
    const brief = await prismaRecyclingBriefStore().get(id, gate.workspaceId);
    if (!brief) return recyclingError(new Error("Brief not found in workspace."));
    const audit = prismaRecyclingAuditStore();
    const [events, chain] = await Promise.all([
      audit.list(brief.id, gate.workspaceId, 200),
      audit.verifyChain(brief.id, gate.workspaceId),
    ]);
    return Response.json({
      brief,
      lineage: verifyLineage(brief),
      audit: { events, chain },
    });
  } catch (err) {
    return recyclingError(err);
  }
}
