// Marketr — Connector Agent slice 1 API.
// POST /api/connector/recompute — the warmth sweep (editor role):
// recompute every relationship's score in this tenant from its stored
// interaction signals. Never touches other tenants' rows.
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaConnectorStore(prisma);
    const result = await store.recomputeAllWarmth(workspace.id);
    return Response.json(result);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
