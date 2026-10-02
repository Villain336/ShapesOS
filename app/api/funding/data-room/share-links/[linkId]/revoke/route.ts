// Marketr — Funding/VC slice 3 API.
// POST /api/funding/data-room/share-links/[linkId]/revoke — revoke a share
//        link (editor). Revoked links 404 at the public route.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ linkId: string }> };

function fundingErrorResponse(e: FundingError) {
  const notFound = ["DOC_NOT_FOUND", "LINK_NOT_FOUND", "VIEW_NOT_FOUND", "VERSION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function POST(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { linkId } = await params;
    const store = new PrismaFundingStore(prisma);
    const link = await store.revokeShareLink(workspace.id, linkId);
    return Response.json({ link });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}
