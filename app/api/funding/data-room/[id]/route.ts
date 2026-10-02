// Marketr — Funding/VC slice 3 API.
// GET    /api/funding/data-room/[id] — doc detail: current version, full
//          version history, share links, recent views.
// DELETE /api/funding/data-room/[id] — delete the doc + its versions, share
//          links, and views (editor). File cleanup is owned by the files
//          trash flow.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function fundingErrorResponse(e: FundingError) {
  const notFound = ["DOC_NOT_FOUND", "LINK_NOT_FOUND", "VIEW_NOT_FOUND", "VERSION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaFundingStore(prisma);
    const document = await store.getDocDetail(workspace.id, id);
    return Response.json({ workspaceId: workspace.id, document });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const store = new PrismaFundingStore(prisma);
    await store.deleteDoc(workspace.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}
