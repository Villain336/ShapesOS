// Marketr — CAD + Hardware slice 1 API.
// GET /api/cad/public/[token]/file — the resolved version's original bytes
//     for the anonymous share-link viewer. Fail-closed: unknown, revoked, or
//     expired tokens 404 (no distinction leaks). Hardened headers via
//     buildDownloadHeaders (nosniff + sandbox). ?dl=1 forces a download.

import { prisma } from "@/lib/prisma";
import { PrismaCadStore } from "@/lib/cad/prisma-store";
import { CadError } from "@/lib/cad/types";
import { buildDownloadHeaders } from "@/lib/filesystem/download";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

export async function GET(req: Request, { params }: Params) {
  try {
    const { token } = await params;
    const store = new PrismaCadStore(prisma);
    const { version, bytes } = await store.getShareTokenFile(token);
    const download = new URL(req.url).searchParams.get("dl") === "1";
    const headers = buildDownloadHeaders(
      version.mimeType ?? "application/octet-stream",
      version.fileName,
    );
    if (download) {
      headers["content-disposition"] = `attachment; filename="${version.fileName.replace(/[\"\\\r\n]/g, "_").slice(0, 200)}"`;
    }
    return new Response(new Uint8Array(bytes), { headers });
  } catch (e) {
    // Fail-closed: every share-link failure looks the same from outside.
    if (e instanceof CadError) {
      return Response.json({ error: "Share link not found." }, { status: 404 });
    }
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
