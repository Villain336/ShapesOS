// Marketr — GET /api/flywheel/ctv/pixel/:id
//
// Marketr-hosted 1×1 impression pixel. Token-verified (HMAC over the
// campaign id); the hit is logged to the local impression ledger —
// impression data never leaves Marketr. This is what the buyer pastes into
// Vibe/vendor as the impression tracker.

import { resolveCtvStore } from "@/lib/flywheel/ctv/store";
import { pixelGifBuffer, pixelSigningSecret, verifyPixelToken } from "@/lib/flywheel/ctv/attribution";

export const dynamic = "force-dynamic";

/** Unset secret in production → no hit is ever counted (the GIF still serves). */
function pixelSecret(): string | null {
  try {
    return pixelSigningSecret();
  } catch {
    return null;
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";

  const store = await resolveCtvStore();
  // Public tag: no workspace hint, so lookup is id-only; the HMAC proves
  // the tag is ours and binds it to its campaign.
  const secret = pixelSecret();
  const pixel = secret ? await store.getPixelAny(id) : null;
  if (pixel && secret && verifyPixelToken(pixel.campaignId, token, secret)) {
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
