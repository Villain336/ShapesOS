# Phase 18 Slice 4 — Walmart Connect: research verdict (OUTCOME B: guided-only)

Date: 2026-10-01. Researcher: slice-4 subagent. Sources: official
developer.walmart.com docs (crawled 2026-09-30/10-01), community MCP README.

## Verdict

**B — no public self-serve developer path exists.** Walmart Connect is shipped
as a registered-but-`guided_only` platform (same model as Spotify in spec §2d).

## What the research established (all from official docs)

1. The Walmart Connect Sponsored Search Ads API is real and documented
   (developer.walmart.com/advertising-partners-search/docs/…): REST, campaign
   list/create/update, ad groups, ad items, keywords, placements, snapshot
   reporting. A separate Display Advertising API family exists too.
2. Access is **exclusively** for Walmart Connect Partner Network (WCPN)
   **partners**. There is NO public OAuth authorize URL for an advertiser to
   connect their own ad account to a third-party SaaS — slice 1's fails-closed
   state was correct.
3. Auth is **partner-level, not per-advertiser**: the partner gets one
   Consumer ID + RSA-SHA256 request-signing keypair + bearer auth token at
   onboarding, then calls APIs with `advertiserId` per client. Headers:
   `Authorization: Bearer <auth_token>`, `WM_CONSUMER.ID`,
   `WM_SEC.AUTH_SIGNATURE`, `WM_SEC.KEY_VERSION`, `WM_CONSUMER.intimestamp`.
4. Onboarding is a **business application**, not self-serve API keys:
   log in at advertising.walmart.com with a Walmart.com account → start the
   partner application → select partner type (**Technology provider** fits
   Marketr: "You offer advertisers a self-serve platform to manage ad
   campaigns, and want to integrate with Walmart Connect APIs") → Walmart
   reviews → upload the RSA public key to the Self-Serve Partner Onboarding
   Platform (developer.walmart.com) → receive Consumer ID / Auth Token / Key
   Version.
5. Campaign management (POST/PUT) requires the **Full-Service API Partner**
   tier; Reporting Only tier is GET + snapshot reports only.

## Why no API connector was built in slice 4

- Marketr cannot complete a WCPN partner application in code — it requires
  Tico to apply as a business and be approved. There is no sandbox or test
  credential flow without a partner application.
- Building an RSA-signing client against documented endpoints with zero
  ability to verify a single live call would be unverifiable code; the slice-4
  brief explicitly forbade fabricating endpoints. So: guided-only now,
  API client later (see unlock path).

## What shipped instead (this slice)

- `walmart` registered as `authKind: "guided"`, `guidedOnly: true`,
  `supportsApiLaunch: false`, `supportsReportingApi: false` in
  lib/adplatforms/types.ts. `startAdsOAuth("walmart")` fails closed with
  GUIDED_ONLY.
- Guided setup flow in the hub (`/dashboard/media/advertising/guided/walmart`):
  WCPN partner-application checklist, RSA keypair instructions, placement
  planner (Sponsored Products / Brands / Video + **Vibe CTV** as a placement
  option, $0 minimum per spec §2c), Sponsored Brands creative specs, manual
  advertiser-ID linking, external campaign registration, and
  manual-or-CSV spend import into AdReport.
- CSV import: `POST /api/ads/guided/import` parses
  `campaign_external_id,date,spend_cents,impressions,clicks,conversions,revenue_cents`,
  validates strictly (row-level errors), and ingests via the slice-1
  `ingestAdReportRows`. Lineage: `platformReceiptId = "import:<batchId>"`;
  unknown campaign ids are counted as skipped, never misattributed.
- Honest UI framing everywhere: "guided", never implied API control.

## Unlock path for the future API slice (for Tico)

1. Apply at https://advertising.walmart.com as a **Technology provider**
   partner; wait for Walmart's approval.
2. Generate an RSA-2048 keypair; upload the public key to the Self-Serve
   Partner Onboarding Platform at https://developer.walmart.com; keep the
   Consumer ID, Auth Token, and Key Version.
3. Store those three values in the Latchkey vault (never in code/chat/logs);
   only an opaque tokenRef lands on the AdAccount row.
4. Have each advertiser grant the Marketr partner access to their ad account
   in Walmart Ad Center; record the advertiser ID on their AdAccount row.
5. Then a follow-up slice can build: RSA-SHA256 request signer
   (lib/adplatforms/walmart/client.ts), campaign CRUD against
   `https://developer.api.walmart.com/api-proxy/service/WPA/Api/v1/api/v1/…`,
   the spend executor wired through the slice-1 gate (no execution without a
   matching SpendApproval), snapshot-report polling → AdReport normalizer,
   and flipping the registry flags back to API-capable.

Until then, every spend action on Walmart Connect happens in Walmart Ad
Center; Marketr proposes nothing and executes nothing there.
