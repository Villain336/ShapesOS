// Marketr — CAD + Hardware slice 1 API.
// GET /api/cad/models/[id]/versions/[vid]/file — the version's original
//     bytes for the in-browser three.js viewer (viewer+, tenant-scoped).
//     ?dl=1 forces a download; otherwise the bytes serve inline for the
//     viewer. Hardened headers via buildDownloadHeaders (nosniff + sandbox).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadStore } from "@/lib/cad/prisma-store";
import { CadError } from "@/lib/cad/types";
import { buildDownloadHeaders } from "@/lib/filesystem/download";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; vid: string }> };

function cadErrorResponse(e: CadError) {
  return Response.json(
    { error: e.message, code: e.code },
    { status: e.code === "VERSION_NOT_FOUND" || e.code === "MODEL_NOT_FOUND" ? 404 : 400 },
  );
}

export async function GET(req: Request, { params }: Params) {
  try {
    const { id, vid } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadStore(prisma);
    const { version, bytes } = await store.getVersionFile(workspace.id, id, vid);
    const download = new URL(req.url).searchParams.get("dl") === "1";
    const headers = buildDownloadHeaders(version.mimeType ?? "application/octet-stream", version.fileName);
    if (download) {
      headers["content-disposition"] = `attachment; filename="${version.fileName.replace(/[\"\\\r\n]/g, "_").slice(0, 200)}"`;
    }
    return new Response(new Uint8Array(bytes), { headers });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
