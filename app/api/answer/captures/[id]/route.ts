// ShapesOS — Phase 21A (WS=agentweb): open a receipt.
// GET /api/answer/captures/:id → { id, url, fetchedAt, domHash, textHash, excerpt, body, signature status … } | 404
// A receipt of a public page is readable by any member of the workspace; a receipt
// of a WORKSPACE record only by the person whose answer cited it. The signature is
// re-checked on every read: "verified" says whether it still holds, and an
// unsigned capture says so (no signing secret was configured when it was made).

import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { getReceiptFor } from "@/lib/answer/service";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await answerActor();
    const { id } = await ctx.params;
    const cap = await getReceiptFor(workspace.id, user.id, id);
    if (!cap) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(
      {
        id: cap.id,
        url: cap.url,
        fetchedAt: cap.fetchedAt,
        domHash: cap.domHash,
        textHash: cap.textHash,
        excerpt: cap.excerpt,
        body: cap.bodyText,
        via: cap.via,
        provider: cap.provider,
        signedWith: cap.signedWith,
        verified: cap.verified,
        retentionUntil: cap.retentionUntil,
        screenshotRef: cap.screenshotRef ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return httpErrorResponse(e);
  }
}
