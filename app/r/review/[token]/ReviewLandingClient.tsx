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
  const accent = brandColor?.trim() || "#6d28d9";

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
    <main className="flex min-h-dvh items-center justify-center bg-stone-50 px-6 py-12">
      <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-8 text-center shadow-sm">
        {logoUrl ? (
          // White-label logo replaces the default star badge when set.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={`${businessName} logo`} className="mx-auto h-14 max-w-[10rem] rounded-2xl object-contain" />
        ) : (
          <div
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl text-white"
            style={{ backgroundColor: accent }}
            aria-hidden
          >
            <Star size={26} fill="currentColor" strokeWidth={0} />
          </div>
        )}
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-stone-900">
          How was your experience with {businessName}?
        </h1>
        <div className="mt-3 flex items-center justify-center gap-1" aria-label="5 out of 5 stars">
          {[0, 1, 2, 3, 4].map((i) => (
            <Star key={i} size={22} className="text-amber-400" fill="currentColor" strokeWidth={0} />
          ))}
        </div>
        <p className="mt-3 text-sm leading-relaxed text-stone-500">
          Your review helps other customers find us — and it only takes a minute.
        </p>
        <button
          onClick={handleCta}
          disabled={state !== "idle"}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-[15px] font-semibold text-white transition active:scale-[0.99] disabled:opacity-70"
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
        <p className="mt-4 text-[11px] text-stone-400">
          You&apos;ll be taken to Google to post your review.
        </p>
        {customDomain && (
          <p className="mt-1 text-[11px] text-stone-400">{customDomain}</p>
        )}
      </div>
    </main>
  );
}
