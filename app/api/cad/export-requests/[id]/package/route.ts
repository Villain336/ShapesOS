// Marketr — CAD + Hardware slice 3 API.
// GET /api/cad/export-requests/[id]/package — download the export package
//       manifest (JSON) for a confirmed/sent request. The model file itself
//       travels via /api/cad/models/[id]/versions/[vid]/file. Drafts 404
//       here (QUOTE_NOT_READY) — nothing is downloadable before confirmation.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["EXPORT_REQUEST_NOT_FOUND", "MODEL_NOT_FOUND", "VERSION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadPipelineStore(prisma);
    const manifest = await store.getPackageManifest(workspace.id, id);
    const body = JSON.stringify(manifest, null, 2);
    return new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="export-manifest-${id}.json"`,
      },
    });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
