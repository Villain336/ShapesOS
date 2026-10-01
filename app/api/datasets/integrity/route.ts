// Marketr — Dataset Builder slice 1 API.
// GET /api/datasets/integrity — the zero-orphaned-chunks audit. Returns
// { orphanedChunks: 0, ok: true } in the healthy state; anything else is a
// data-integrity incident surfaced to the register view.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { verifyNoOrphanedChunks } from "@/lib/datasetbuilder/register";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaDatasetBuilderStore(prisma);
    const orphans = await verifyNoOrphanedChunks(store, workspace.id);
    return Response.json({
      ok: orphans.length === 0,
      orphanedChunks: orphans.length,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
