# Marketr Phase 4 — Direct Mail Research (2026-09-24)

Grounded facts for the Phase 4 spec. Sources with dates inline. Items I could
not verify are flagged `[UNVERIFIED]` or `[STALE?]`.

## 1. Lob

**Pricing (per piece, includes print + postage; tier-dependent).**
- Developer (free): ~$0.80–$0.91/postcard, $0.94/letter. Limits: 1 user, 10
  templates, 500 mailings/mo, 1 webhook.
- Startup ($260/mo): ~$0.545–$0.645/postcard, $0.77/letter.
- Growth ($550/mo): ~$0.515–$0.615/postcard, $0.74/letter.
- Volume reality check: 10–50k pcs/mo typically lands $0.55–$0.75/postcard;
  100k+/mo can drop below $0.50 with multi-year commitments.
- Sources: [Oppizi vs Lob, updated ~Sep 2026](https://oppizi.com/us/en/resources/blog/direct-mail/oppizi-vs-lob/);
  [SaaSworthy, updated 2026-09-23](https://www.saasworthy.com/product/lob-address-verification/pricing);
  [G2 Lob pricing](https://www.g2.com/products/lob/pricing);
  [Vendr](https://www.vendr.com/marketplace/lob). Numbers vary slightly by
  source — use ranges, not point values.

**Test/sandbox mode.** Yes: `test_`-prefixed API keys. Full API access in
sandbox; postcards/letters render and appear in the dashboard, nothing is
physically mailed until you swap to a live key. Recommended: set a 2-hour
cancellation window while testing. Source: [Lob blog — webhooks
tutorial](https://www.lob.com/blog/using-lob-webhooks-to-send-delivery-notifications-in-rails)
(older article; test-key mechanics still current per 2026 docs).

**Webhooks / tracking.** Yes. USPS scan-driven events: In Transit → In Local
Area → Processed for Delivery (+ Re-routed, Returned to Sender). Real-time
event webhooks; webhook management API exists. Sources:
[Lob blog](https://www.lob.com/blog/using-lob-webhooks-to-send-delivery-notifications-in-rails);
[Lob direct-mail network post](https://www.lob.com/blog/direct-mail-network-infrastructure-scaling-print-delivery-for-enterprise).

**Address verification + NCOA.** Lob processes addresses with USPS-certified
CASS + NCOA tooling (source: lob.com). But: verification is a **paid add-on**
(~$0.05/additional US verification on Developer; Startup $25/mo for 1,000
US + $0.025/each; international billed separately). NCOA caveat: USPS only
releases NCOA-suppressed (changed) address data via a dashboard CSV export,
and only after ≥100 live requests in a calendar week
([help.lob.com](https://help.lob.com/print-and-mail/reaching-your-audience/additional-lob-ncoa-functionality)).
No streaming NCOA-changes API. USPS itself is launching a new NCOA 3.0 API
(July 2026, monthly subscription + signed license,
[PostalPro notice](https://postalpro.sequirly.co/mnt/glusterfs/2026-03/INFORMATIONAL%20-%20%20NCOA%20API%20%20Launching%20July%202026.pdf))
— a future direct path, not integrated by Lob today.

**API quality / docs reputation.** Best-in-class docs among mail APIs
(O
...[truncated 6638 chars]