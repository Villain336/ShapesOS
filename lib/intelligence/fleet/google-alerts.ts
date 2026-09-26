// Marketr — Phase 10 M4: Google Alerts as the consumer-tool baseline.
//
// Spec §M4: "Google Alerts as the 30-second consumer-tool baseline for
// indexed new pages." This module is GUIDANCE TEXT ONLY — surfaced in the
// competitors UI as a docs note. Marketr never scrapes Google Alerts
// (it's a consumer product; automating it would violate its ToS).

/** Markdown guidance rendered in the competitors UI (Digest tab). */
export function googleAlertsGuidance(competitorDomain: string): string {
  const domain = competitorDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return [
    `### Google Alerts baseline — ${domain}`,
    ``,
    `Marketr's fleet watches **sitemaps** (what competitors publish). Google Alerts watches **Google's index** (what Google actually picked up). The two disagree usefully — a page in the sitemap that never gets indexed is a signal in itself.`,
    ``,
    `**30-second setup** (do this in your own Google account — Marketr never touches Google Alerts):`,
    ``,
    `1. Go to google.com/alerts while signed in.`,
    `2. Create an alert for: \`site:${domain}\``,
    `3. Set "How often" → **At most once a week**, "How many" → **All results**.`,
    `4. Deliver to your inbox or an RSS reader.`,
    ``,
    `**Reading it against the fleet:** new URLs in the alert that never appeared in the fleet's sitemap diff were likely published without a sitemap update (or via a sitemap we don't watch yet — add it in the Watchlist tab). New fleet URLs missing from the alert after 2+ weeks may have indexing problems worth investigating on your own site too.`,
  ].join("\n");
}
