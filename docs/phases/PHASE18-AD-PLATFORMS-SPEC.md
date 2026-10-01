# Phase 18 — Ad Platforms Expansion (Phase 1): "Buy everywhere, approve everything"

Research: `~/workspace/biz-os/research/ad-platforms-expansion.md` (2026-09-29). Tico approved Phase 1: **Amazon Ads, StackAdapt, Walmart Connect, Spotify (guided)**. Meta already covered. Everything else is Phase 2 (watch) or Phase 3 (playbook-only, no API exists).

## 0. Standing constraints (non-negotiable)

- **Zero custody of client spend** — the advertiser's own billing on every platform. Marketr never holds or moves ad money.
- **Autopilot never buys media** — every spend action is propose → approve. No standing spend authority.
- **One ads home** (merge doctrine): one campaign object model, one reporting/analytics surface across all platforms.
- Credentials in the Latchkey vault, never in chat/logs/code.

## 1. Ontology (platform-agnostic core, built once)

New Prisma models:

- `AdPlatform` — amazon | stackadapt | walmart | spotify (+ meta existing). Stores auth config, API base, capabilities flags (`supports_api_launch`, `supports_reporting_api`, `guided_only`).
- `AdAccount` — tenant's linked account per platform: external account id, OAuth token ref (vault), status, billing owner = advertiser.
- `AdCampaign` — unified campaign: name, objective, platform, external id, status (draft/proposed/live/paused/ended), budget, flight dates.
- `AdGroup` — ad set / line item level (platform-native naming mapped).
- `AdCreative` — creative asset refs + platform status.
- `SpendProposal` — THE gate. Every launch, budget change, or new flight creates one: proposed by (human/agent), payload, status (pending/approved/rejected/executed). Execution requires an approval record.
- `SpendApproval` — immutable: proposal id, approver, timestamp, scope hash.
- `AdReport` — normalized daily metrics per campaign: spend, impressions, clicks, CTR, conversions, revenue (when attribution available). Lineage: report row → campaign → approval → platform receipt id.

Governed actions (humans and agents use the same bounded set): `connect_account`, `propose_campaign`, `approve_spend`, `launch`, `pause`, `adjust_budget` (via new proposal), `pull_report`. No action spends without a `SpendApproval`.

## 2. Platform connectors

### 2a. Amazon Ads (direct API)
- Auth: Amazon Ads API developer program (approval required per tenant app) + OAuth.
- v1: account/campaign read, sponsored products/brands campaign proposal → approval → launch, pause, budget adjust (via proposal), Sponsored TV where eligible. $0 minimums.
- Reporting: API performance reports → `AdReport`.

### 2b. StackAdapt (direct API)
- Auth: API key/OAuth per tenant seat.
- v1: campaign proposal → approval → launch across native/display/video/CTV/audio/DOOH, ChatGPT inventory where available, pause, budget adjust (via proposal).
- This one connector also lights up the piggyback surfaces: NCM cinema (PMP), newspaper-digital inventory, programmatic podcast audio — surfaced in UI as inventory options, not separate integrations.

### 2c. Walmart Connect (direct API)
- Auth: Walmart Connect developer/partner program + OAuth.
- v1: sponsored products/brands/videos proposal → approval → launch, pause, budget adjust (via proposal); Vibe CTV surfaced as a placement option ($0 minimum).
- Reporting: API reports → `AdReport`.

> **RESEARCH OUTCOME — slice 4 (2026-10-01, OUTCOME B: guided-only).** The
> Sponsored Search Ads API is real (developer.walmart.com) but exclusive to
> Walmart Connect Partner Network partners — there is NO public OAuth
> authorize URL. Auth is a single partner-level credential (Consumer ID +
> RSA-SHA256 request signing + bearer token) issued after a BUSINESS
> application at advertising.walmart.com, which cannot be completed in code.
> Walmart therefore ships guided-only (same model as §2d): WCPN
> partner-application checklist, placement planner (incl. Vibe CTV, $0
> minimum), creative specs, manual advertiser-ID linking, external campaign
> registration, and CSV spend import into AdReport. The RSA-signing API
> client is a follow-up slice after Tico's WCPN partner approval. Full
> verdict + unlock path: `docs/phases/PHASE18-SLICE4-WALMART.md`.

### 2d. Spotify (guided self-serve + reporting — NO public campaign API)
- No launch automation. Product = guided setup flow (account checklist, audience/geo/budget planner, creative spec checker, UTM + pixel template) → user launches in Spotify Ads Manager ($250 minimum) → Marketr tracks via UTM/pixel attribution and manual-or-CSV spend import into `AdReport`.
- Honest framing in UI: "guided," never implied API control. DSP route (via StackAdapt audio) noted as the programmatic alternative.

## 3. Where it lives in the product

- Grow pillar → Advertising: one dashboard (accounts, campaigns, proposals inbox, unified reports). Proposal inbox is the approval surface — also reachable from the OS command bar / agent chat ("propose a $500 Amazon sponsored-products test" → draft proposal → human approves → launches).
- Reporting feeds the single analytics home; spend/ROAS roll into client performance reports (Phase 16 report engine).

## 4. Build order (Tico's pieces rule — each slice: code → typecheck → tests → commit)

1. **Slice 1 — Ads ontology + approval plumbing.** Prisma models, `connect_account` OAuth scaffolding, propose→approve→execute flow, proposal inbox UI, `AdReport` skeleton. Verifiable without any platform API.
2. **Slice 2 — Amazon Ads connector.** Read + propose/launch/pause + reporting.
3. **Slice 3 — StackAdapt connector.** Same surface + inventory options (cinema/newspaper-digital/audio flags).
4. **Slice 4 — Walmart Connect connector.** Same surface + Vibe CTV placement.
5. **Slice 5 — Spotify guided flow.** Setup wizard, UTM/pixel templates, spend import, reporting.
6. **Slice 6 — Unified reporting + proposal inbox polish.** Cross-platform ROAS view, client report feed.

One slice at a time on the build box. No slice starts until the previous is committed.

## 5. Verification (definition of done per slice)

- tsc clean, unit tests for the approval gate (no execution path without `SpendApproval` — test the negative), OAuth connect/disconnect round-trip, proposal → approval → launch → pause lifecycle against sandbox where the platform offers one, report normalization spot-checked against raw platform exports.

## 6. Cost & license reality check

- All four are vendor APIs/SaaS — no license risk, no embedding. API access is per-tenant (their developer programs, their approvals).
- No media margin: Marketr charges the platform subscription; ad spend stays on the advertiser's card.

## DECISIONS — LOCKED by Tico 2026-09-29

- Phase 1 = Amazon Ads + StackAdapt + Walmart Connect + Spotify (guided). Phase 2/3 deferred.
- Zero custody of client spend; autopilot never buys media; every spend action proposed and explicitly approved.

## OPEN DECISIONS

- Queue position: does Phase 18 start after Phase 16/17 land, or interleave?
- Pricing/packaging: included in Grow tier vs add-on per connector?
- Agency white-label: do sub-accounts (GHL-style snapshots) get per-client ad accounts in v1?
