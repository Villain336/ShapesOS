// Marketr — Dataset Builder slice 3 API.
// GET /api/datasets/[id]/versions — version history for one dataset,
// each version with its compile settings and lineage summary
// (which sources, which models).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { getVersionLineage } from "@/lib/datasetbuilder/build";
import { DATASET_TYPE_LABELS } from "@/lib/datasetbuilder/classify";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaDatasetBuilderStore(prisma);

    const dataset = await store.getDataset(id);
    if (!dataset || dataset.workspaceId !== workspace.id) {
      return Response.json({ error: "Dataset not found" }, { status: 404 });
    }
    const versions = await store.listDatasetVersions(id);
    const history = [];
    for (const v of versions) {
      const lineage = await getVersionLineage(store, v.id);
      history.push({
        id: v.id,
        version: v.version,
        chunkCount: v.chunkCount,
        compiledAt: v.compiledAt.toISOString(),
        settings: v.settings,
        sources: lineage.sources,
        documents: lineage.documents,
        engines: lineage.engines,
      });
    }
    return Response.json({
      dataset: {
        id: dataset.id,
        type: dataset.type,
        label: DATASET_TYPE_LABELS[dataset.type],
        name: dataset.name,
      },
      versions: history,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
