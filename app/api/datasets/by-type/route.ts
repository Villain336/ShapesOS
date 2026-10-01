// Marketr — Dataset Builder slice 2 API.
// GET /api/datasets/by-type — chunks grouped by dataset type.
// Returns applied counts per type, plus unclassified + pending-review counts
// so the UI can show the full picture (including the unclassified bucket).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import {
  DATASET_TYPES,
  DATASET_TYPE_LABELS,
} from "@/lib/datasetbuilder/classify";
import { getTypeBreakdown } from "@/lib/datasetbuilder/structure";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaDatasetBuilderStore(prisma);
    const breakdown = await getTypeBreakdown(store, workspace.id);
    return Response.json({
      workspaceId: breakdown.workspaceId,
      types: DATASET_TYPES.map((t) => ({
        type: t,
        label: DATASET_TYPE_LABELS[t],
        count: breakdown.byType[t],
      })),
      unclassified: breakdown.unclassified,
      pendingReview: breakdown.pendingReview,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
