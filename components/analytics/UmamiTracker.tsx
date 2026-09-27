// Marketr — Phase 12 "embeds": Umami tracking snippet for public pages.
// Client component. Rendered ONLY when the server passes a websiteId +
// scriptUrl (both are public values; the API key never leaves the server).
// Umami is cookieless, so no consent banner is required.

"use client";

import Script from "next/script";

export function UmamiTracker({
  websiteId,
  scriptUrl,
}: {
  websiteId: string;
  scriptUrl: string;
}) {
  return (
    <Script
      src={scriptUrl}
      data-website-id={websiteId}
      strategy="afterInteractive"
    />
  );
}
