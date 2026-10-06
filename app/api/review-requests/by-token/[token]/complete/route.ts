// Marketr — R4: public completion endpoint for the QR landing page.
// POST /api/review-requests/by-token/[token]/complete
//
// No session: the token is the capability (unlisted random identifier),
// mirroring the /r/[slug] vanity model. Rate-limited per token+IP.
// Called by the landing page when the customer taps the review CTA.

import { markCompletedByToken } from "@/lib/reviews/engine";
import { checkReviewPageRateLimit, clientIp } from "@/lib/reviews/rate-limit";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const clean = token.trim().slice(0, 64);
  if (!(await checkReviewPageRateLimit(clean, clientIp(req)))) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }
  const updated = await markCompletedByToken(clean);
  if (!updated) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (updated.status === "expired") {
    return Response.json({ error: "This review link has expired" }, { status: 410 });
  }
  return Response.json({ ok: true, status: updated.status });
}
