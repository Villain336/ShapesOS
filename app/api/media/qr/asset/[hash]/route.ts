// Marketr — Phase 5 A1: GET /api/media/qr/asset/[hash]
//
// Serves a print-locked QR PNG by its sha256 hash (the value bound into the
// per-buy approval object / tracking_links.qr_png_url).

import { listDir, readFile } from "@/lib/filesystem/service";
import { mediaGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const g = await mediaGuard("viewer");
  if (g instanceof Response) return g;
  const { hash } = await ctx.params;
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    return Response.json({ error: "Invalid asset hash." }, { status: 400 });
  }
  const name = `${hash.toLowerCase()}.png`;
  const listing = await listDir({ workspaceId: g.workspaceId, prefix: "/files/studio/qr" });
  const file = listing.files.find((f) => f.filename.toLowerCase() === name || f.logicalPath.endsWith(`/${name}`));
  if (!file) return Response.json({ error: "QR asset not found." }, { status: 404 });
  const got = await readFile({ workspaceId: g.workspaceId, fileId: file.id });
  if (!got) return Response.json({ error: "QR asset not found." }, { status: 404 });
  const bytes = got.bytes;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/png",
      "content-length": String(bytes.length),
      "cache-control": "public, max-age=31536000, immutable",
      "x-qr-asset-hash": hash.toLowerCase(),
    },
  });
}
