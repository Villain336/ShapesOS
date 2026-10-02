// Marketr — Connector Agent slice 1 API.
// GET /api/connector/graph — the tenant's whole connector graph: persons
// (with relationships, employments, provenance), companies, import batches.
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaConnectorStore(prisma);
    const graph = await store.listGraph(workspace.id);
    return Response.json(graph);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
