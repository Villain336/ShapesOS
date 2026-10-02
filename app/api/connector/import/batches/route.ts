// Marketr — Connector Agent slice 2 API.
// GET /api/connector/import/batches — the tenant's import batches with
// run lifecycle (status, cursor, stats, error) and provenance.
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaConnectorStore(prisma);
    const batches = await store.listImportBatches(workspace.id);
    return Response.json({ batches });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
