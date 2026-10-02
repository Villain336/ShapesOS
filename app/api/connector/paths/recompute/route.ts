// Marketr — Connector Agent slice 3 API.
// POST /api/connector/paths/recompute — the path sweep trigger (editor
// role): refresh cached top paths for this tenant (bounded: at most 25
// candidate targets, 10 paths each). Scheduled recompute hits
// /api/cron/connector-paths instead.
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "@/lib/connector/prisma-store";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaConnectorStore(prisma);
    const result = await store.warmPathCache(workspace.id);
    return Response.json(result);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
