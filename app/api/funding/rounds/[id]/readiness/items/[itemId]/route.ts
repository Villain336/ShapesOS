// Marketr — Funding/VC slice 4 API.
// PATCH /api/funding/rounds/[id]/readiness/items/[itemId] — update one
//        checklist item (editor): status, notes, evidence. Transition rules:
//        done stamps completedAt/completedBy; leaving done clears the stamp;
//        waived requires a reason in notes.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; itemId: string }> };

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { itemId } = await params;
    const body = (await readJson(req)) as {
      status?: unknown;
      notes?: unknown;
      evidence?: unknown;
    };
    const store = new PrismaFundingStore(prisma);
    const actor = user.email ?? user.id ?? "founder";
    const item = await store.updateChecklistItem(workspace.id, itemId, body, actor);
    return Response.json({ workspaceId: workspace.id, item });
  } catch (e) {
    if (e instanceof FundingError) {
      const notFound = ["CHECKLIST_ITEM_NOT_FOUND", "ROUND_NOT_FOUND"];
      return Response.json(
        { error: e.message, code: e.code },
        { status: notFound.includes(e.code) ? 404 : 400 },
      );
    }
    return httpErrorResponse(e);
  }
}
