// Marketr — Dataset Builder slice 4 API.
// GET /api/datasets/[id]/publish-status — which version is live on each
// target, and whether a newer compiled version is waiting (stale).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { getPublishStatus } from "@/lib/datasetbuilder/activate";
import { DATASET_TYPE_LABELS } from "@/lib/datasetbuilder/classify";
import { DatasetBuilderError } from "@/lib/datasetbuilder/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaDatasetBuilderStore(prisma);

    try {
      const { dataset, targets } = await getPublishStatus(
        store,
        workspace.id,
        id,
      );
      return Response.json({
        dataset: {
          id: dataset.id,
          type: dataset.type,
          label: DATASET_TYPE_LABELS[dataset.type],
          name: dataset.name,
        },
        targets,
      });
    } catch (e) {
      if (e instanceof DatasetBuilderError && e.code === "UNKNOWN_DATASET") {
        return Response.json({ error: "Dataset not found" }, { status: 404 });
      }
      throw e;
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
