// Marketr — Funding/VC slice 4 API.
// POST /api/funding/rounds/[id]/safe-templates/select — record the
//        founder's SAFE template pick (editor) as evidence on the
//        safe_template checklist item (which also moves to done).

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as {
      templateKey?: unknown;
      valuationCapUsd?: unknown;
      discountPct?: unknown;
      note?: unknown;
    };
    const store = new PrismaFundingStore(prisma);
    const actor = user.email ?? user.id ?? "founder";
    const item = await store.selectSafeTemplate(workspace.id, id, body, actor);
    return Response.json({ workspaceId: workspace.id, roundId: id, item });
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
