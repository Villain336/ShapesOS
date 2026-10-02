// Marketr — CAD + Hardware slice 3 API.
// POST /api/cad/export-requests/[id]/confirm — tenant confirms the quote
//        request (human-only). Writes the vendor-ready export package
//        (model file + manifest with checksum + process parameters +
//        contact/shipping) to the workspace file store. No vendor API is
//        called; no order is placed.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["EXPORT_REQUEST_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaCadPipelineStore(prisma);
    const request = await store.confirmExportRequest(
      workspace.id,
      { kind: "human", identity: user.email ?? user.id },
      id,
    );
    return Response.json({ request });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
