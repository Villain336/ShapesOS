// Marketr — GET /api/flywheel/ctv/pixel/:id
//
// Marketr-hosted 1×1 impression pixel. Token-verified (HMAC over the
// campaign id); the hit is logged to the local impression ledger —
// impression data never leaves Marketr. This is what the buyer pastes into
// Vibe/vendor as the impression tracker.

import { getCtvStore } from "@/lib/flywheel/ctv/store";
import { pixelGifBuffer, verifyPixelToken } from "@/lib/flywheel/ctv/attribution";

export const dynamic = "force-dynamic";

function pixelSecret(): string {
  return process.env.PIXEL_SIGNING_SECRET ?? "dev-only-pixel-secret";
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";

  const store = getCtvStore();
  // Public tag: no workspace hint, so lookup is id-only; the HMAC proves
  // the tag is ours and binds it to its campaign.
  const pixel = await store.getPixelAny(id);
  if (pixel && verifyPixelToken(pixel.campaignId, token, pixelSecret())) {
    await store.incrementImpressions(pixel.id);
    await store.audit({
      workspaceId: pixel.workspaceId, actor: "pixel",
      action: "pixel_impression", subjectType: "pixel", subjectId: pixel.id,
      detail: { campaignId: pixel.campaignId },
    }).catch(() => {});
  }
  // Always serve the GIF: a logging failure must not break the vendor tag.
  return new Response(new Uint8Array(pixelGifBuffer()), {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
