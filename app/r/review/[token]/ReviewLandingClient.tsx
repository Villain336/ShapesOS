// Marketr — R4: public review landing page (client interactivity).
// Light-mode, mobile-first — customers open this from a QR scan on their phone.
// CTA tap → marks the request completed via the public token endpoint, then
// deep-links to the stored review URL (Google).

"use client";

import { useState } from "react";
import { Star, ArrowRight, Loader2 } from "lucide-react";

export function ReviewLandingClient({
  token,
  businessName,
  reviewUrl,
  brandColor,
  logoUrl,
  customDomain,
}: {
  token: string;
  businessName: string;
  reviewUrl: string;
  brandColor: string | null;
  /** Public white-label logo URL (/api/public/workspaces/[id]/logo), or null. */
  logoUrl: string | null;
  /** White-label custom domain, or null (displayed as brand text only). */
  customDomain: string | null;
}) {
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  // The tenant's saved brand color is user data (white-label), so it stays
  // literal; with none set the CTA is the system's black primary.
  const accent = brandColor?.trim() || "var(--aos-ink)";

  async function handleCta() {
    if (state !== "idle") return;
    setState("sending");
    try {
      await fetch(`/api/review-requests/by-token/${encodeURIComponent(token)}/complete`, {
        method: "POST",
      });
    } catch {
      // Completion is best-effort: the customer still gets to the review form.
    } finally {
      setState("done");
      window.location.href = reviewUrl;
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-6 py-12">
      <div className="w-full max-w-sm rounded-xl bg-paper p-8 text-center shadow-hairline">
        {logoUrl ? (
          // White-label logo replaces the default star badge when set.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={`${businessName} logo`} className="mx-auto h-14 max-w-[10rem] rounded-lg object-contain" />
        ) : (
          <div
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg text-paper"
            style={{ backgroundColor: accent }}
            aria-hidden
          >
            <Star size={26} fill="currentColor" strokeWidth={0} />
          </div>
        )}
        <h1 className="mt-5 text-xl font-heading stretch-heading tracking-heading text-ink">
          How was your experience with {businessName}?
        </h1>
        <div className="mt-3 flex items-center justify-center gap-1" aria-label="5 out of 5 stars">
          {[0, 1, 2, 3, 4].map((i) => (
            <Star key={i} size={22} className="text-ink" fill="currentColor" strokeWidth={0} />
          ))}
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Your review helps other customers find us — and it only takes a minute.
        </p>
        <button
          onClick={handleCta}
          disabled={state !== "idle"}
          className="mt-6 flex h-control-lg w-full items-center justify-center gap-2 rounded-full px-6 text-[15px] font-semibold text-paper aos-press disabled:opacity-70"
          style={{ backgroundColor: accent }}
        >
          {state === "sending" ? (
            <>
              <Loader2 size={18} className="animate-spin" /> Opening review form…
            </>
          ) : (
            <>
              Leave a Google review <ArrowRight size={18} />
            </>
          )}
        </button>
        <p className="mt-4 text-xs text-muted">
          You&apos;ll be taken to Google to post your review.
        </p>
        {customDomain && (
          <p className="mt-1 text-xs text-muted">{customDomain}</p>
        )}
      </div>
    </main>
  );
}
