// Marketr — Funding/VC slice 3 API.
// GET /api/funding/data-room/views — per-viewer analytics (spec §3: "who
//        opened what, when"). Query: docId?, linkId?, limit? (max 500).
//        Newest first; tenant-scoped.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const url = new URL(req.url);
    const store = new PrismaFundingStore(prisma);
    const views = await store.listViews(workspace.id, {
      docId: url.searchParams.get("docId") ?? undefined,
      linkId: url.searchParams.get("linkId") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? "100") || 100,
    });
    return Response.json({ workspaceId: workspace.id, views });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
