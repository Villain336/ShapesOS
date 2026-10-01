// Marketr — Dataset Builder slice 3 API.
// GET /api/datasets/health — dataset health panel data: coverage (what %
// of chunks are classified into datasets), freshness (age of newest data
// per dataset), and staleness alerts.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { getDatasetHealth } from "@/lib/datasetbuilder/health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaDatasetBuilderStore(prisma);
    const health = await getDatasetHealth(store, workspace.id);
    return Response.json({
      workspaceId: health.workspaceId,
      generatedAt: health.generatedAt.toISOString(),
      totalChunks: health.totalChunks,
      classifiedChunks: health.classifiedChunks,
      coveragePct: health.coveragePct,
      datasets: health.datasets.map((d) => ({
        type: d.type,
        label: d.label,
        appliedChunks: d.appliedChunks,
        coveragePct: d.coveragePct,
        latestVersion: d.latestVersion,
        latestCompiledAt: d.latestCompiledAt?.toISOString() ?? null,
        newestDataAt: d.newestDataAt?.toISOString() ?? null,
        newestDataAgeDays: d.newestDataAgeDays,
        stale: d.stale,
        chunksSinceCompile: d.chunksSinceCompile,
      })),
      alerts: health.alerts,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
