// Marketr — Dataset Builder slice 2 API.
// GET /api/datasets/reviews — pending review queue, each item bundled with
// the suggested type, confidence, chunk text, and document/source names so
// a human can decide without hunting for context.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { DATASET_TYPE_LABELS } from "@/lib/datasetbuilder/classify";
import { listReviewQueue } from "@/lib/datasetbuilder/structure";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaDatasetBuilderStore(prisma);
    const queue = await listReviewQueue(store, workspace.id);
    return Response.json({
      workspaceId: workspace.id,
      pending: queue.map((d) => ({
        reviewId: d.review.id,
        classificationId: d.classification.id,
        suggestedType: d.classification.datasetType,
        suggestedTypeLabel: DATASET_TYPE_LABELS[d.classification.datasetType],
        confidence: d.classification.confidence,
        engine: d.classification.engine,
        chunkText: d.chunkText,
        documentName: d.documentName,
        sourceName: d.sourceName,
        createdAt: d.review.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
