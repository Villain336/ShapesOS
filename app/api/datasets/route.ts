// Marketr — Dataset Builder slice 3 API.
// GET /api/datasets — every dataset type with its applied chunk count and
// latest compiled version (null when never compiled).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import {
  DATASET_TYPES,
  DATASET_TYPE_LABELS,
} from "@/lib/datasetbuilder/classify";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaDatasetBuilderStore(prisma);

    const datasets = [];
    for (const type of DATASET_TYPES) {
      const applied = (
        await store.listClassificationsByType(workspace.id, type)
      ).filter((c) => c.status === "applied");
      const dataset = await store.getDatasetByType(workspace.id, type);
      const latest = dataset
        ? await store.getLatestDatasetVersion(dataset.id)
        : null;
      datasets.push({
        id: dataset?.id ?? null,
        type,
        label: DATASET_TYPE_LABELS[type],
        appliedChunks: new Set(applied.map((c) => c.chunkId)).size,
        latestVersion: latest?.version ?? null,
        latestCompiledAt: latest?.compiledAt.toISOString() ?? null,
        latestChunkCount: latest?.chunkCount ?? null,
      });
    }
    return Response.json({ datasets });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
