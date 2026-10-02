// Marketr — Connector Agent slice 4 API.
// GET /api/connector/intros/[id] — the introduction with its full lifecycle
// timeline (every approval event: who proposed, who accepted, what was
// said, when).
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaIntroductionStore } from "@/lib/connector/introduction-store";
import { ConnectorError } from "@/lib/connector/types";
import { introErrorResponse } from "../intro-error";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaIntroductionStore(prisma);
    const intro = await store.getIntroductionDetail(workspace.id, id);
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
