# Phase 18 Slice 5 — Spotify: research verdict (guided-only)

Date: 2026-10-01. Researcher: slice-5 subagent. Sources: official
ads.spotify.com help center pages (crawled 2026-10-01); spotify/ads-agentic-tools
public repo measurement docs; third-party Spotify Pixel implementation guides
(bluefroganalytics.com, flagged where used).

## Verdict

**Guided-only — same model as Walmart Connect in slice 4, and the same
model the Phase 18 spec §2d (Tico-locked 2026-09-29) prescribed for Spotify.**
There is no self-serve, per-advertiser OAuth/API path a third-party SaaS can
use today to connect an advertiser's Spotify Ad Studio account, launch
campaigns, or read performance. So: guided setup flow in the codebase,
staged behind the "coming soon" badge (see staging decision below).

## What the research established (all from official docs)

1. **Self-serve path is Spotify Ads Manager (Ad Studio).** Account setup is
   a human path: free Spotify account with a **business email** (team
   alias, not a personal account) → create an Ad Studio account →
   Manage ad accounts → **+Ad accounts** → team roles (Admin — the only
   role that edits account settings and payment details — contributors,
   viewers) → billing in account settings.
   Source: https://ads.spotify.com/en-NL/help-center/getting-started-with-ad-studio/
2. **$250 minimum lifetime budget.** "Launch a campaign with a minimum
   budget of 250.00 in your local currency." Enforced in the slice as a
   planner floor (`planSpotifyBudget`), never silently accepted.
   Source: same help-center page.
3. **Audio creative specs (official):** 30 seconds or less; WAV/MP3/OGG;
   max 1 MB (Ad Studio); WAV 16-bit 44.1 kHz; MP3 ≥ 192 kbps; RMS
   normalized to 14 dBFS, peak −0.2 dBFS; stereo; −16 LUFS (±1.5), true
   peak ≤ −2.0 dBTP; script ≤ 65 words for 30 s; advertiser name ≤ 25 chars.
   **Companion image:** square, ≥ 640 × 640 px, JPEG or PNG, ≤ 200 KB.
   Sources: https://ads.spotify.com/en-CA/help-center/audio-ad-creative/
   and https://ads.spotify.com/en-IN/ad-experiences/audio-ads-specs/
4. **Measurement.** Spotify appends an `spclid` click ID to ad landing URLs
   (per the spotify/ads-agentic-tools measurement docs), so redirects must
   preserve query strings end to end — the UTM builder says this in the UI.
   The Spotify Pixel base code (`https://pixel.spotify.com/v1/pixel.js`,
   `spotify('init','PIXEL_ID')`, events PageView / Purchase / Lead / SignUp)
   is documented in third-party implementation guides — it ships in the
   slice as a **reference template only** (explicitly labeled; the canonical
   snippet comes from Ad Studio → Events/Pixel).
5. **DSP alternative.** Spotify audio inventory can also be bought
   programmatically — the slice-3 StackAdapt connector is the honest
   cross-link for that route, surfaced in the banner copy and planner notes.

## Why no API connector was built in slice 5

- There is no public per-advertiser OAuth or reporting API for Ad Studio
  that a third-party SaaS can onboard an advertiser through today. The
  slice-1 gate fails closed on this: `startAdsOAuth("spotify")` returns
  GUIDED_ONLY.
- The one API signal is a **watch item, not a build target**: the public
  repo `spotify/ads-agentic-tools` (updated days before this slice)
  documents an Ads API v3 (OAuth 2.0 + PKCE, draft/publish campaign
  endpoints), but access appears partner/beta-gated. If v3 opens to
  self-serve advertisers, a follow-up slice can build the direct connector.
  Until then, guided-only stands per spec §2d.

## What shipped (this slice, 4 pieces)

- **5a** (`e7b9dc7`): `lib/adplatforms/spotify/guided.ts` — Ads Manager
  account checklist (7 steps, official help-center links), `$250-minimum`
  budget planner, audio creative spec checker (30s / WAV-MP3-OGG / 1MB;
  square ≥640px JPEG/PNG / ≤200KB; unverifiable inputs return `pass:null`,
  never assumed), UTM builder (`utm_source=spotify` fixed), Spotify Pixel
  reference template, manual ad-account linking, external campaign
  registration, strict CSV spend parser + import input builder
  (`platformReceiptId = "import:<batchId>"`, `approvalId: null`).
  36/36 tests, tsc clean.
- **5b** (`da3937c`): `/api/ads/guided/account`, `/guided/campaign`,
  `/guided/import` dispatch on platform — spotify routes to the slice-5a
  functions; fail-closed on non-guided platforms.
- **5c** (`a8d0267`): Spotify guided page
  (`app/dashboard/media/advertising/guided/spotify/`) with 7 client
  components: GuidedChecklist (localStorage persistence), BudgetPlanner
  (audience worksheet + flight dates + $250 floor messaging),
  CreativeSpecChecker (real file verification: byte size, audio duration
  via metadata, image dimensions via decode), UtmBuilder (copyable tagged
  URL + pixel template), LinkAdvertiserForm, RegisterCampaignForm,
  CsvImportForm. Official spec table rendered from `SPOTIFY_AUDIO_SPECS`.
  Amber no-API banner; "guided" framing everywhere. Pure planning
  primitives extracted to `lib/adplatforms/spotify/planning.ts`
  (prisma-free for client import); `guided.ts` re-exports them.
- **5d** (this doc).

## Staging decision (Tico, 2026-09-30, commit `53e67c4`)

Walmart Connect + Spotify ship as **"coming soon" badges** in the ad hub —
the guided flows stay in the codebase, staged behind the badge until
launch. Verified during this slice: no route or component anywhere in
`app/` links to `guided/walmart` or `guided/spotify`; the hub
`ConnectButton` was not changed. The guided pages are reachable by URL
only, exactly like the walmart flow.

## Unlock path for the future API slice (for Tico)

1. Watch the `spotify/ads-agentic-tools` repo and the Spotify Ads API v3
   for a self-serve advertiser onboarding path (OAuth 2.0 + PKCE today is
   partner/beta-gated).
2. When a public path opens: register Marketr as a Spotify Ads API app,
   wire OAuth through the slice-1 gate (`startAdsOAuth("spotify")` stops
   failing closed), store the tokenRef in the Latchkey vault — only an
   opaque ref on the AdAccount row, never the credential.
3. Then a follow-up slice can build: API client
   (`lib/adplatforms/spotify/client.ts`), campaign CRUD/reporting against
   the v3 endpoints, spend reporting → AdReport normalizer, and flipping
   the registry flags back to API-capable.
4. Zero custody of client spend holds regardless: billing stays on the
   advertiser's own card; autopilot never buys media (spec §0).

Until then, every spend action on Spotify happens in Spotify Ads Manager;
Marketr proposes nothing and executes nothing there.
