// ShapesOS — Phase 21A round 2 (WS=agentweb): GET /api/agentweb/captures/:id/screenshot
// — the screenshot kept with a receipt (only when the page was captured through the browser).
// Any member of the workspace that owns the capture; 404 otherwise. Served as a PNG with nosniff.

import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { blobGet, parseBlobRef } from "@/lib/filesystem/storage";
import { getCapture } from "@/lib/agentweb/captures-store";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await answerActor();
    const { id } = await ctx.params;
    const cap = await getCapture(workspace.id, id);
    const ref = cap?.screenshotRef ? parseBlobRef(cap.screenshotRef) : null;
    if (!cap || !ref || ref.namespace !== "web-captures" || !ref.path.startsWith(`${workspace.id}/`)) return notFound();
    const bytes = await blobGet(ref.namespace, ref.path);
    if (!bytes) return notFound();
    return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png", "x-content-type-options": "nosniff", "cache-control": "private, max-age=300", "content-security-policy": "default-src 'none'; sandbox" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
