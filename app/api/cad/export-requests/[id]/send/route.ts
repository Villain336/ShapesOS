// Marketr — CAD + Hardware slice 3 API.
// POST /api/cad/export-requests/[id]/send — record the tenant's own
//        transmission of the package (human-only; body: recipient,
//        sentViaAccount). v1 does NOT place orders: no vendor API is called
//        and nothing is transmitted externally — this only records who sent
//        it, when, to whom, and via which of the tenant's connected accounts.

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
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadPipelineStore(prisma);
    const request = await store.sendExportRequest(
      workspace.id,
      { kind: "human", identity: user.email ?? user.id },
      id,
      { recipient: body?.recipient ?? "", sentViaAccount: body?.sentViaAccount ?? "" },
    );
    return Response.json({ request });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
