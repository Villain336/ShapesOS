// Marketr — Funding/VC slice 4 API.
// POST /api/funding/rounds/[id]/readiness/test-links — "test" every
//        investor-facing share link (editor): resolves revoked/expired state
//        without opening anything, and records the result as evidence on the
//        data_room_links checklist item.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const store = new PrismaFundingStore(prisma);
    const result = await store.testDataRoomLinks(workspace.id, id);
    return Response.json({ workspaceId: workspace.id, roundId: id, ...result });
  } catch (e) {
    if (e instanceof FundingError) {
      return Response.json(
        { error: e.message, code: e.code },
        { status: e.code === "ROUND_NOT_FOUND" ? 404 : 400 },
      );
    }
    return httpErrorResponse(e);
  }
}
