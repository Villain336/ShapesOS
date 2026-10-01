// Marketr — Dataset Builder slice 2 API.
// POST /api/datasets/reviews/[id] — decide a pending review.
//   JSON body: { action: "approve" | "reassign" | "reject",
//                datasetType?: <required for reassign>, note?: string }
// approve → suggested type applies; reassign → human's type applies;
// reject → chunk stays unclassified, never force-fit. Decisions are final.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { DATASET_TYPES } from "@/lib/datasetbuilder/classify";
import { decideReview } from "@/lib/datasetbuilder/structure";
import { DatasetBuilderError } from "@/lib/datasetbuilder/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  action: z.enum(["approve", "reassign", "reject"]),
  datasetType: z.enum(DATASET_TYPES).optional(),
  note: z.string().max(2000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const input = BodySchema.parse(await req.json());
    const store = new PrismaDatasetBuilderStore(prisma);

    const review = await store.getReviewItem(id);
    if (!review || review.workspaceId !== workspace.id) {
      return Response.json({ error: "review not found" }, { status: 404 });
    }

    const { classification, appliedType } = await decideReview(store, id, {
      action: input.action,
      datasetType: input.datasetType,
      note: input.note,
      decidedBy: workspace.id,
    });

    return Response.json({
      reviewId: id,
      action: input.action,
      classificationStatus: classification.status,
      appliedType,
    });
  } catch (e) {
    if (
      e instanceof DatasetBuilderError &&
      e.code === "REVIEW_ALREADY_DECIDED"
    ) {
      return Response.json(
        { error: "this review was already decided" },
        { status: 409 },
      );
    }
    return httpErrorResponse(e);
  }
}
