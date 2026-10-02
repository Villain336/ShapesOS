// Marketr — Funding/VC slice 4 API.
// PATCH  /api/funding/rounds/[id]/cap-table/[stakeholderId] — edit a row (editor).
// DELETE /api/funding/rounds/[id]/cap-table/[stakeholderId] — remove a row (editor).

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; stakeholderId: string }> };

function fundingErrorResponse(e: FundingError) {
  const notFound = ["ROUND_NOT_FOUND", "STAKEHOLDER_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { stakeholderId } = await params;
    const body = (await readJson(req)) as Record<string, unknown>;
    const store = new PrismaFundingStore(prisma);
    const row = await store.updateStakeholder(workspace.id, stakeholderId, body);
    return Response.json({ workspaceId: workspace.id, row });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { stakeholderId } = await params;
    const store = new PrismaFundingStore(prisma);
    await store.deleteStakeholder(workspace.id, stakeholderId);
    return Response.json({ workspaceId: workspace.id, deleted: stakeholderId });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}
