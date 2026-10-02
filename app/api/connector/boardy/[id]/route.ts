// Marketr — Connector Agent slice 6 API.
// GET /api/connector/boardy/[id] — one request with its audit lineage (viewer).
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaBoardyRailStore } from "@/lib/connector/boardy-rail";
import { ConnectorError } from "@/lib/connector/types";
import { introErrorResponse } from "../../intros/intro-error";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const request = await new PrismaBoardyRailStore(prisma).getBoardyRequest(workspace.id, id);
    return Response.json({ request });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
