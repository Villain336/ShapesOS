// Marketr — R4: public review landing page. GET /r/review/<token>.
// No auth: the token is the capability (unlisted random identifier), mirroring
// the /r/[slug] vanity model. Rate-limited per token+IP (30/min).
// Loads → marks the request "viewed". CTA tap → POSTs the public complete
// endpoint, then deep-links the customer to the stored Google review URL.

import { notFound } from "next/navigation";
import { getRequestByToken, markViewedByToken } from "@/lib/reviews/engine";
import { checkReviewPageRateLimit } from "@/lib/reviews/rate-limit";
import { ReviewLandingClient } from "./ReviewLandingClient";
import { clientIpFromHeaders } from "@/lib/api/client-ip";

export const metadata = { title: "Leave a review — ShapesOS" };

export default async function ReviewLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const clean = token.trim().slice(0, 64);

  // next/headers gives us the real client IP behind the proxy.
  const { headers } = await import("next/headers");
  const h = await headers();
  const ip = clientIpFromHeaders(h) ?? "unknown";
  if (!checkReviewPageRateLimit(clean, ip)) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-stone-50 px-6">
        <p className="text-sm text-stone-500">Too many requests — please try again in a minute.</p>
      </main>
    );
  }

  const req = await getRequestByToken(clean);
  if (!req) notFound();

  if (req.status === "expired") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-stone-50 px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-stone-900">This link has expired</h1>
          <p className="mt-2 text-sm text-stone-500">
            This review invitation is no longer active. You can still find{" "}
            {req.workspace.name} on Google to leave a review.
          </p>
        </div>
      </main>
    );
  }

  await markViewedByToken(clean);

  return (
    <ReviewLandingClient
      token={clean}
      businessName={req.workspace.name}
      reviewUrl={req.reviewUrl ?? "https://www.google.com/maps"}
      brandColor={req.workspace.whiteLabelBrandColor}
      // Logo + domain are white-label fields set under Settings → White-label.
      logoUrl={req.workspace.whiteLabelLogoUrl ? `/api/public/workspaces/${req.workspace.id}/logo` : null}
      customDomain={req.workspace.whiteLabelCustomDomain}
    />
  );
}
