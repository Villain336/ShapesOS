# SPEC — Phase 5: Media Buying v1

**Status:** APPROVED by Tico 2026-09-25; built and verified 2026-09-25 (commit `feat(phase5)`).
**Date:** 2026-09-25
**Master plan ref:** `docs/MASTER-PLAN.md` — "Phase 5 — Media buying v1 (2–3 cycles)"
**Research:** `docs/phase5-research.md` (DOOH landscape, AdQuick status, radio/print, non-custodial spend controls, offline attribution — all 2026-grounded)

---

## 1. What Phase 5 builds

Eight build tracks, in a hard order. **The safety system ships before the first dollar moves.**

| Track | What | Why this order |
|---|---|---|
| **S1 — Generalized C3 trust ladder for media** | The fix agent's ladder promoted to a platform primitive: approval rungs for money movement, two-person rules, OTP-verified approvals, backup approvers, execution windows | Every track below depends on it; this is the load-bearing safety layer |
| **S2 — Non-custodial budget pools** | Per-client pool objects: caps, encumbrance accounting, platform allowlists, utilization alerts; dual enforcement = software encumbrance + virtual-card-per-pool on the **client's own** Brex/Ramp card | The "media wallet" without custody — resolves the deferred money-custody decision as client-driven |
| **S3 — Per-buy binding + executor re-verification** | Approval object that cryptographically binds inventory, exact spend, creative hash, dates, terms; executor re-verifies everything at checkout; quote-then-book for direct deals | Kills TOCTOU attacks and "the price changed" accidents — the red-lane core |
| **S4 — Kill switches** | Two-layer: Marketr sweeper (Birch-style rule engine) + platform-native rules provisioned as backup; client-level emergency stop | Protection that survives Marketr outages; the €7,937/day failure class dies here |
| **B1 — DOOH planner + concierge** | Planning UI + launch-packet generator against Blip first, Blindspot second, Adomni optional; execution in the client's own operator account | First buying path: no BD required, no minimums on the lead vendors |
| **B2 — Streaming audio** | Concierge planning + self-serve execution for Spotify Ads Manager, Acast, AudioGo | The executable leg — real buys with the shortest path to "money moved safely" |
| **B3 — Radio/newspaper IO-brief concierge** | IO-brief generator (IAB/AAAA template); rep keeps the signature | Honest architecture: no buying API exists for broadcast/print |
| **A1 — Offline attribution** | Per-placement QR/pURL engine (self-hosted), promo/vanity codes, branded-search lift dashboard with geo-holdouts, CallRail integration | Proof it worked — directional, never causal, at SMB scale |

### The core design decisions

1. **Client-driven spend, zero custody.** Marketr never holds, fronts, or co-mingles client money. Spend flows from the client's own accounts/cards; Marketr plans, proposes, and executes only with approvals. This resolves MASTER-PLAN Appendix A Q2 (client-money posture): with no custody, there is no money-transmitter exposure for v1.
2. **Safety before spend.** S1–S4 are complete and battery-proven before any buying path executes a real dollar.
3. **Autopilot never buys media.** Not a ladder stage, not an exception, never. This is a standing invariant (MASTER-PLAN §3.1), not a Phase 5 choice.
4. **Honest execution model.** No DOOH vendor in the 2026 landscape exposes a public buy-side API; broadcast radio and print are rep-driven. Concierge is the architecture, not a stopgap. AdQuick API buying stays PARKED (no outreach, no AdQuick code); AdQuick self-serve deep-linking as a referral channel is allowed (plan in Marketr → checkout on adquick.com).
5. **Attribution is directional.** At SMB scale, per-placement QR/pURL + promo codes + branded-search lift with geo-holdouts is the honest maximum. Footfall vendors are deferred (enterprise contracts, statistically invalid at SMB panel sizes, shrinking under 2026 privacy regulation).

---

## 2. Track-by-track build plan

### S1 — Generalized C3 trust ladder for media

Promote the existing fix-agent ladder into a platform registry. Every money-moving module declares its rung, escalation triggers, and rollback story.

- **Rung assignments (fixed):** all media buying = **supervised, always**. Planning, attribution computation, receipt reconciliation = scheduled/autopilot-safe. Budget reallocations = supervised (propose; human approves).
- **Approval state machine:** `draft → pending → approved → executed | expired | revoked`. Same machine for buys, IO briefs, and pool draws.
- **Two-person rules:** creator ≠ approver, always (enforced at the service layer, not just hidden in UI). Second approver required above the two-person threshold — **default $1K proposed** [NEEDS TICO DECISION — see §12.1].
- **High-value approvals:** OTP/TOTP confirmation creating a cryptographically verified approval record (PubMatic AgenticOS pattern, 2026).
- **Backup approvers** designated in advance per workspace (no approval dead-ends when the owner is offline).
- **Execution window:** approvals must execute within 72h of approval (configurable per workspace); stale approvals expire and re-enter the queue — never execute.
- **Roles (separation of duties as a fraud control):** agency `owner` / `media_buyer` / `viewer`. Media buyers propose but never approve. Client logins see only their workspace's branded surface.

### S2 — Non-custodial budget pools (dual enforcement)

The "media wallet" as accounting, not custody. A `BudgetPool` is a cap with a ledger — the money itself never passes through Marketr.

- **Pool object:** `id, workspace_id, client_id, name, period (monthly|campaign|one_time), cap_amount_cents, currency, remaining_cents, encumbered_cents, platform_allowlist[], auto_approve_threshold_cents (default 0/disabled), utilization alerts (50/75/90%), virtual_card_ref, status (active|frozen|exhausted), created_by, created_at`.
- **Encumbrance lifecycle (the IO "maximum amount to be spent" made programmatic):**
  - Approval → `encumbered_cents += max_total_spend` (pool can never encumber beyond `remaining_cents`; over-encumbrance is rejected at the service layer).
  - Execution → encumbrance converts to actual spend; receipt reconciliation (track A1) trues up ledger vs platform actuals.
  - Expiry / revocation → encumbrance released.
- **Dual enforcement:**
  1. **Software layer:** Marketr pool caps + executor pre-flight (track S3).
  2. **Money layer (backstop):** virtual card per pool, issued on the **client's** Brex/Ramp account with limit = pool cap. Card declines survive Marketr software bugs — this is the layer that kills the €7,937/day failure class (see §9.5).
- **Account separation:** one ad account / Business Manager per client (prevents cross-client spend contamination and ban blast radius). Platform-native ceilings set *before* launch: Meta account spending limits via API; Google Ads campaign budgets — noting honestly that Google has **no true account-level monthly cap** (campaign daily budgets have 2× single-day flex), so on Google the virtual card + sweeper are the ceiling.
- **Never:** Marketr fronts media on the agency's card; co-mingling across clients; platform "average" spend limits treated as hard caps (Meta's 25%/75% flex and Google's 2× daily flex are real).

### S3 — Per-buy binding object + executor re-verification

The red-lane core: what was approved is exactly what executes, or nothing executes.

**Approval object schema** (`media_approvals`):
- **Binding (immutable once approved):** `platform, client_ad_account_id, deal_type (auction|pd|pg|pa), line_items[] (inventory, pricing_model, max_allowed, flight_dates, targeting_snapshot, creative_ids[] + sha256 creative_hashes), max_total_spend_cents, currency, quote_id + quote_expires_at (direct deals), drift_tolerance (default 10% price / 5% spend), cancel_terms, operator_terms_version`.
- **Authority:** `approvers[] (user, decided_at, method: sso|otp|signed-link), two_person_satisfied (bool), approvals_expires_at (default +72h), revoked_at/by`.
- **Audit:** append-only `media_approval_events (ts, actor, action, payload_hash)` — the IAB event-bus pattern.
- **Cryptographic binding:** SHA-256 of the canonical binding JSON stored on the approval; any field change invalidates it (TOCTOU kill).

**Executor pre-flight (EXECUTE)** — every assertion must pass or the buy HALTS:
1. Approval exists, is `approved`, unexpired, unrevoked.
2. Two-person provenance verified (creator ≠ approver; second approver present if over threshold).
3. Direct deals: re-fetch quote; not expired; price within drift tolerance. Auction: re-hash creatives (mismatch = halt), diff launch config vs approved targeting snapshot.
4. Platform ∈ pool allowlist; pool `remaining_cents ≥ max_total_spend`.
5. Account spending limit set/asserted (Meta); campaign budgets within pool (Google).
6. Creative review status = approved; billing profile valid (client's own instrument).
7. Write platform-native guardrails at approved values; register buy with the kill-switch sweeper; append events.

**HALT semantics:** status stays `approved` (not executed); approver + requester notified with the exact diff; re-approval covers only what changed.

**Quote-then-book (IAB pattern):** quotes are explicitly non-binding, carry `expires_at`, and booking references `quote_id`. Expired quote → re-quote before booking, never execute stale.

**Prompt-injection defense:** operator pages are untrusted content. The executor treats page text as data, never instructions; confirmation screens are parsed against the approved order, never obeyed. Mismatch = halt + alert.

### S4 — Two-layer kill switch + client emergency stop

**Layer 1 — Marketr sweeper** (scheduled job: 5–15 min for critical rules, hourly for trend rules). Birch-style rule engine: `{ name, scope, condition, window, action (pause|reduce_budget|alert), cooldown }`. Default v1 rule pack:
- Stop-loss pause: CPA > 1.5× target AND spend > $100.
- Test-cap kill: > $25 spend with zero conversions.
- Spend-anomaly alert: daily spend > 80% of budget before noon.
- Pool-exhausted → pause all pool entities.
- Creative-fatigue kill (CTR decay vs baseline, configurable).
- Every sweeper action is logged to the approval's event log — **every action traces back to a rule a human set.**
- Circuit breaker: 3 failed executions → freeze the channel, alert the owner.

**Layer 2 — Platform-native rules as backup.** Provisioned at campaign creation (Meta automated rules via `adrules_library`; Google Ads rules/scripts) so protection survives a Marketr outage. Native rules are the seatbelt; the sweeper is the airbag.

**Client-level emergency stop:** one action from `/dashboard/media` pauses every active entity for a client across all platforms, revokes pending approvals, freezes all pools, and exports the audit trail. Requires approver role + written reason; logged immutably.

**Never in v1:** autopilot purchasing; budget increases without re-approval; relying on platform "average" limits as hard caps.

### B1 — DOOH planner + concierge

- **Planner UI** (`/dashboard/media/dooh`): screen/inventory selection, daypart mix, budget planning with live estimate ranges (Blip from $0.01/blip; Blindspot from ~$0.23/play; programmatic CPM $2–$15 — denominators differ, compare with caution).
- **Vendor order (locked):** Blip first (self-serve, no minimums, free agency reseller program — Launchabl should enroll), Blindspot second (global, hourly/per-play), Adomni optional (self-serve, no minimums).
- **Launch-packet generator:** an approved buy compiles to a launch packet (inventory, budget, flight, creative files + hashes, per-placement QR/pURL assignments, tracking checklist). Execution happens **in the client's own Blip/Blindspot/Adomni account** — either via the sandboxed browser-agent executor (least privilege, DOM-verified final order screen per MASTER-PLAN §3.2.3, receipt capture) or human-executed with the packet checklist + receipt upload. The packet is the durable artifact; the browser agent is the convenience path.
- **Creative:** DOOH creatives come from Creative Studio (Phase 4) — formats extended with DOOH sizes in this phase.
- **AdQuick:** no API integration (parked). Self-serve deep-linking as referral-only: plan in Marketr → checkout on adquick.com. Revisit only if Tico authorizes BD.
- **Programmatic DOOH (Vistar/Place Exchange/Broadsign supply via DSP seat):** execution deferred; Marketr can *prepare* PMP-ready plans (screens, CPM guardrails, venue targeting) for clients who hold a DSP seat.

### B2 — Streaming audio (the executable leg)

Concierge planning + self-serve execution — the shortest path to "money moved safely":
- Planner: station/podcast/streaming selection, spot mix, budget; generated brief + budget → launched in the client's own account on **Spotify Ads Manager** (min €15/day, €250 lifetime), **Acast** ($250 min), or **AudioGo** ($250 min, reaches iHeart/SiriusXM/Cumulus/Audacy streaming inventory).
- Approval + binding + sweeper coverage identical to B1 (S1–S4 are channel-agnostic).
- Attribution: per-spot/per-station promo codes + vanity URLs (A1), CallRail tracking numbers (A1/[NEEDS TICO DECISION]).

### B3 — Radio / newspaper IO-brief concierge

- **Broadcast radio:** IO-brief generator — station selection (SRDS/Nielsen data), daypart mix, spot plan, IO terms on the IAB/AAAA template (deliverables, prices, **maximum amount to be spent**, start/end dates, third-party ad server identity). Plan in Marketr → **human rep executes the signature**. Insertion tracking + proof-of-run capture in Marketr.
- **Newspaper print:** media-kit research + IO-brief generation; rep signs. Newspaper *digital* display = separate programmatic leg (v1.5, not this phase).
- **Magazines:** lowest priority — planning/IO-brief generation only (6–8 week lead times, heaviest rep dependence).
- Creative for audio: spot scripts via the content engine → approval queue; production ($500–2,000+ typical) is a client cost, tracked in the buy's cost ledger.

### A1 — Offline attribution

Build natively:
- **Per-placement QR/pURL engine:** self-hosted link infrastructure (Dub OSS — approved, see §12.4), one vanity short URL + QR per placement (`brand.link/board-47`), dynamic destinations (no reprint), UTM auto-tagging, scan analytics, campaign rollup via `utm_content`/tags. Extends the Phase 2 physical-attribution kit. Only place QR where there's dwell time (transit shelters, street furniture, pedestrian streets — never highway boards, per OAAA best practices).
- **Fully customizable QR codes (approved 2026-09-25, non-negotiable):** every generated QR is brand-customizable — brand foreground/background colors with contrast guardrails (scannability check before export), client logo or image embedded in the center, dot styles (square, rounded, dots), corner/eye styles, quiet-zone/margin control, printable frames with CTA text ("Scan for 20% off"), error-correction levels up to H for logo-bearing codes, high-res PNG + vector SVG export, and a live scannability-verified preview before the creative is locked to print. The print-locked creative hash in the per-buy approval object covers the final customized QR asset.
- **Chat-generated QR styling (approved 2026-09-25):** the QR designer lives in Creative Studio, chat-first. The user describes the look in natural language ("round QR, modules as little snakes, brand colors, logo in the center") and the AI designs the module glyph (SVG), tiles it onto the real QR matrix, applies shape masks (round, etc.), colors, and logo. The AI never touches the encoded data — only the artwork layer. **Automated validation before any preview ships:** glyph fill-percentage per cell, contrast ratio, finder-pattern integrity, quiet zone, error correction forced to H for styled codes. Failures come back in chat with the reason ("snakes too thin — they'd mis-scan") plus a bolder regenerated variant. Every styled code must pass a real scan test before print-lock; styled codes that fail stay out of the approval object.
- **Promo/vanity-code generator** for radio/print/audio: unique code per station/spot/publication with redemption tracking.
- **Branded-search lift dashboard:** GSC + Google Trends pulls, 4–6 week pre-campaign baseline windows, flight-date alignment, device segmentation (billboards drive mobile), board-metro vs holdout-metro views.
- **Direct-traffic + GBP lift panels** as supporting indicators (direction requests, calls, website clicks before/during/after the flight).
- **Report-card honesty (ships in v1, non-negotiable):** every offline report card carries the caveats — scan rates are tiny and selection-biased; attribution ≠ incrementality (without a geo-holdout you cannot claim causation, and SMB budgets rarely buy enough geography for holdouts); branded-search lift conflates all concurrent marketing; AI search is breaking the click trail (sessions under-counted ~3×, landing as "direct"). Directional indicators, never causal claims.

Integrate: **CallRail** for per-station/per-publication tracking numbers (~$45–55/mo client cost, full API/webhooks) — native in v1 (approved, §12.3).

Defer: footfall vendors (Foursquare/Cuebiq/GroundTruth — enterprise contracts, invalid at SMB panel sizes), Spotify Ad Analytics pixel (gated by buying Spotify inventory — document how-to only).

---

## 3. User flows

### F1 — Set up the safety rails (owner, once per client)
1. Owner creates a `BudgetPool`: cap, period, platform allowlist, two-person threshold, backup approvers.
2. Owner connects the client's Brex/Ramp account; a virtual card is issued for the pool with limit = pool cap. Pool status: `active`. [NEEDS TICO DECISION — §12.2 if this is v1 or a documented manual step.]
3. One ad account / Business Manager per client is linked (never shared across clients).

### F2 — Propose a buy (media buyer)
1. Buyer builds the plan in the DOOH planner / audio planner / IO-brief generator.
2. Creative is picked from Studio (hash-stamped) or a spot script from the content engine.
3. System shows the full binding preview: inventory, exact max spend, dates, terms, pool impact (encumbrance preview), kill-switch rules that will apply.
4. Buyer submits → approval `pending`. If above the auto-approve threshold or outside a pre-approved pool lane, routes to owner.

### F3 — Approve (owner / approver)
1. Approver reviews the exact binding (diff-highlighted vs any prior version).
2. High-value buys: OTP/TOTP confirmation creates the cryptographically verified record.
3. Approve → pool encumbers `max_total_spend`; approval clock starts (72h to execute).

### F4 — Execute (executor)
1. Pre-flight re-verification (S3) runs; on any failure → HALT with diff, approver notified.
2. Browser-agent executes in the client's own operator account (DOM-verified final screen) or human executes from the launch packet; receipt captured.
3. Platform-native guardrails written at approved values; buy registered with the sweeper.
4. Buy status → `executed`; encumbrance converts to spend.

### F5 — Kill (automatic or human)
1. Sweeper rule trips → pause/reduce/alert per the rule; logged to the approval's event log with the rule that fired.
2. Owner hits **emergency stop** → everything for the client pauses, approvals revoked, pools frozen, audit trail exported.

### F6 — Reconcile (scheduled + on demand)
1. Sweeper polls platform spend via APIs; ledger vs platform actuals/invoices compared.
2. Variance surfaced on `/dashboard/media/reconciliation`; drift alerts to the owner.

### F7 — Attribute (A1)
1. Per-placement links/codes created at buy time; scans, calls, redemptions flow into the attribution ledger.
2. Branded-search lift dashboard shows baseline → flight → holdout comparison with the honest caveats printed on the card.

---

## 4. Data model (new tables)

- `media_approvals` — workspace_id, client_id, type (buy|io_brief|pool_draw), status (draft|pending|approved|executed|expired|revoked), binding_json (immutable), binding_hash, max_spend_cents, currency, quote_id, quote_expires_at, drift_tolerance, created_by, approvers_json, two_person_satisfied, approval_method, approvals_expires_at, revoked_at/by, executed_at
- `media_approval_events` — approval_id, ts, actor, action, payload_hash (append-only)
- `budget_pools` — workspace_id, client_id, name, period, cap_cents, remaining_cents, encumbered_cents, platform_allowlist[], auto_approve_threshold_cents, alert_thresholds, virtual_card_ref, status (active|frozen|exhausted)
- `pool_transactions` — pool_id, approval_id, kind (encumber|spend|release|adjust), amount_cents, running_remaining_cents, ts, actor
- `media_buys` — workspace_id, approval_id, pool_id, platform, client_ad_account_id, status, platform_campaign_ref, receipt_url, executed_at, actual_spend_cents
- `dooh_plans` — workspace_id, buy_id, vendor (blip|blindspot|adomni), placements_json, dayparts, estimate_cents, launch_packet_url, status
- `audio_buys` — workspace_id, buy_id, vendor (spotify|acast|audiogo), stations_json, brief_url, status
- `io_briefs` — workspace_id, buy_id, channel (radio|newspaper|magazine), rep_contact, io_terms_json, brief_pdf_url, signature_status, proof_of_run_url
- `tracking_links` — workspace_id, buy_id, placement_ref, slug, destination_url, utm_json, qr_png_url, scans_count, status (self-hosted Dub or equivalent; no third-party data egress)
- `promo_codes` — workspace_id, buy_id, code, channel_ref, redemptions_count
- `call_numbers` — workspace_id, buy_id, provider (callrail), number_e164, station_ref, calls_count
- `lift_snapshots` — workspace_id, buy_id, source (gsc|gtrends|ga4|gbp), baseline_json, flight_json, holdout_json, captured_at
- `media_receipts` — buy_id, platform_invoice_ref, amount_cents, captured_at, reconciled (bool), variance_cents
- `kill_rules` — workspace_id, name, scope, condition_json, window, action, cooldown, enabled, created_by

All tables workspace-isolated. No raw card PANs in Marketr's DB — only `virtual_card_ref`s. No live key material in logs.

---

## 5. API routes

All under `app/api/media/*` (note: `app/api/programmatic/*` is programmatic **SEO** — the media-buying namespace must not collide with it).

- `POST /api/media/approvals` · `GET /api/media/approvals/:id` · `POST /api/media/approvals/:id/approve` (OTP for high-value) · `POST /api/media/approvals/:id/revoke`
- `POST /api/media/pools` · `GET /api/media/pools/:id` · `POST /api/media/pools/:id/virtual-card` (issue/attach client's Brex/Ramp card) · `POST /api/media/pools/:id/freeze`
- `POST /api/media/buys/:id/execute` (runs the full S3 pre-flight, then dispatches the executor)
- `POST /api/media/emergency-stop` (approver role + reason; pauses everything for a client)
- `GET/POST /api/media/kill-rules` · `POST /api/media/kill-rules/:id/toggle`
- `POST /api/media/dooh/plans` · `POST /api/media/dooh/plans/:id/launch-packet`
- `POST /api/media/audio/briefs`
- `POST /api/media/io-briefs`
- `POST /api/media/links` (per-placement QR/pURL) · `GET /api/media/links/:slug/analytics`
- `POST /api/media/promo-codes`
- `GET /api/media/lift` (branded-search dashboard data: baseline/flight/holdout)
- `GET /api/media/reconciliation` (ledger vs platform actuals, variance)
- `POST /api/webhooks/callrail` (call events → attribution ledger; signature-verified, idempotent)

---

## 6. UI routes

- `/dashboard/media` — command center: pool utilization, pending approvals, active buys, kill-switch status, emergency stop (one action, fenced)
- `/dashboard/media/approvals/:id` — the binding review screen: exact terms, diffs, approver history, OTP confirm, execute
- `/dashboard/media/pools` · `/dashboard/media/pools/:id` — caps, encumbrance ledger, utilization alerts, virtual-card status
- `/dashboard/media/dooh` — planner (screens/dayparts/budget) + plans list + launch packets
- `/dashboard/media/audio` — streaming-audio planner + briefs
- `/dashboard/media/radio-print` — IO-brief generator, signature tracking, proof-of-run
- `/dashboard/media/attribution` — per-placement scans/calls/redemptions, branded-search lift with holdouts, report cards with printed caveats
- `/dashboard/media/reconciliation` — ledger vs platform actuals, variance flags
- Settings → Media: operator connections, Brex/Ramp card linkage, roles (owner/media buyer/viewer), two-person threshold, kill-rule defaults

---

## 7. MVP scope

**In:**
- S1: generalized C3 ladder registry; two-person rules; OTP high-value approvals; backup approvers; 72h execution windows; role separation (owner/media buyer/viewer)
- S2: budget pools with encumbrance accounting; platform allowlists; utilization alerts; dual enforcement (software + virtual-card-per-pool on the client's card); one-BM-per-client; Meta account spending limits + Google campaign budgets set pre-launch
- S3: per-buy binding object (inventory, exact spend, creative hash, dates, terms); executor pre-flight with HALT semantics; quote-then-book; prompt-injection defense
- S4: Marketr sweeper with the default v1 rule pack; platform-native rules provisioned as backup; client-level emergency stop; execution circuit breaker
- B1: DOOH planner + launch-packet generator (Blip first, Blindspot second, Adomni optional); execution in the client's own operator account (browser-agent with DOM-verified final screen, or human with packet + receipt upload); AdQuick referral deep-linking only
- B2: streaming-audio planner + generated briefs for Spotify Ads Manager / Acast / AudioGo
- B3: radio/newspaper IO-brief generator on the IAB/AAAA template; rep signature tracking; proof-of-run capture; magazines planning-only
- A1: per-placement QR/pURL engine (self-hosted); promo/vanity codes; branded-search lift dashboard with geo-holdouts; direct-traffic + GBP lift panels; report cards with honest caveats; CallRail integration (pending §12.3)
- Exit gates: adversarial buying battery, receipt reconciliation, audit-trail proofs, kill-switch trip proofs

**Out (non-goals):**
- Any Marketr-held client funds (standing — client-driven spend only)
- Autopilot purchasing of any kind (standing)
- AdQuick API buying — PARKED (no outreach, no AdQuick code, per Tico's explicit decision)
- Programmatic DOOH execution via DSP seat (prepare PMP-ready plans only; seat comes when aggregate volume justifies it — Phase 7)
- Footfall/visit-lift vendors (enterprise-only, invalid at SMB scale)
- Spotify Ad Analytics pixel (document how-to only)
- Newspaper digital display buying (v1.5 programmatic leg)
- TV/CTV buying (Phase 7)
- Budget increases without re-approval (the €7,937/day class — structurally impossible by design)

---

## 8. Monetization (per master plan §4)

- **Hosted:** media planning fee or % of managed spend (the retainer-replacement pitch: "run your $3k/mo retainer delivery on a $199 platform"); creative on the existing AI-word meter; attribution computation bundled as the tier upsell.
- **Self-hosted:** bring your own operator accounts, Brex/Ramp, CallRail; Marketr charges nothing on media spend.
- **Metering:** new meters for media planning actions ride the existing credit ledger; pass-through cost ledger tracks operator spend separately from Marketr margin (never mixed — MASTER-PLAN §3.3).
- The QR/pURL engine and lift dashboards are pure software — cheapest build in the phase, highest proof-of-value per dollar.

---

## 9. Safety invariants

These are structural, not configurable. A build that violates any of them fails the phase.

1. **Supervised always.** Money movement never reaches autopilot — not a ladder stage, not an exception.
2. **Client-driven funds.** Marketr never holds, fronts, or co-mingles client money. The custody decision is resolved: no custody, no money-transmitter exposure for v1.
3. **Binding is total.** The approval cryptographically binds inventory, exact spend, creative hash, dates, and terms. Any change between approval and execution invalidates the token — the buy re-enters approval.
4. **Approvals expire.** 72h default execution window; expired quotes are re-quoted, never executed.
5. **The €7,937/day class is structurally impossible.** That failure — an automation bug compounding a 25% hourly budget increase to €7,937/day in 4 days — happened because state didn't persist and no account-level ceiling existed. Phase 5 prevents it three ways: (a) hard caps enforced at ≥2 independent layers (software encumbrance + virtual-card limit + platform account spending limit), (b) budget increases always require fresh approval (the 20%-per-change rule for bid/budget edits), (c) the sweeper's spend-anomaly rule fires before noon-budget-exhaustion becomes a four-day fire.
6. **Creatives are re-hashed at execution.** Mismatch = halt. The human approved *that* creative, not a lookalike.
7. **Two-person, always.** Creator ≠ approver; second approver above threshold. Separation of duties is a fraud control.
8. **Kill switches default-on.** The sweeper rule pack ships enabled; the emergency stop is one action from the media command center.
9. **Operator pages are untrusted.** Prompt-injection defense on the browser-agent executor; confirmation screens parsed against the approved order, never obeyed.
10. **One BM per client.** No shared ad accounts, no cross-client spend contamination.
11. **Everything is logged.** Append-only, hash-chained, per-workspace, exportable. Actions without an approval are rejected at the service layer.

---

## 10. Success metrics / exit gates

1. **Adversarial buying battery green 3×:** approval-bypass attempt, cap-exceed attempt, creative swap post-approval, stale-quote execution, double-spend, encumbrance race, revoked-approval execution, cross-workspace pool access, operator-price-changed-at-checkout — all fail closed and are logged.
2. **Receipt reconciliation:** ledger vs platform actuals/invoices within rounding on a real test spend; variance surfaced, never silent.
3. **Audit-trail proofs:** every proposed → approved → executed transition deterministically recorded, hash-chained, and exportable per workspace.
4. **Kill-switch trip proof:** spend-anomaly rule fires and pauses in test; emergency stop pauses all client entities and freezes pools.
5. **Encumbrance math proof:** pool cannot over-encumber; expiry/revocation releases; concurrent approvals can't double-count.
6. **Attribution E2E:** per-placement QR scan → ledger; promo-code redemption → ledger; lift dashboard renders baseline/flight/holdout with caveats printed.
7. Standing bar: TypeScript clean, production build green, M11 security battery green, module batteries green ×3, secret scan clean, independent verification before commit.

---

## 11. Honest limitations

- **No buy-side APIs exist** for Blip, Blindspot, or Adomni as of Sept 2026. Execution is browser-agent or human inside the client's own operator account; browser-agent flows can break when operators A/B test checkout. The launch packet is the durable artifact.
- **Broadcast radio and print are rep-driven.** Marketr plans, briefs, and measures; it doesn't intermediate. IO-brief quality depends on rate-card freshness.
- **AdQuick API stays parked** — no programmatic OOH via AdQuick in v1; referral deep-linking only.
- **Attribution is directional at SMB scale.** QR scans are a thin, selection-biased slice of response; branded-search lift conflates concurrent marketing; geo-holdouts are often infeasible on small budgets; AI search is polluting the click trail. The report card says this out loud.
- **Google Ads has no true account-level monthly cap** — on Google, the ceiling is the virtual card + the sweeper, not a platform setting.
- **Platform "average" limits are not hard caps** (Meta single-day flex, Google 2× daily) — the spec never treats them as such.
- **Client costs are real:** streaming-audio minimums ($250 Acast/AudioGo, €250 Spotify lifetime), CallRail ~$45–55/mo, radio production $500–2,000+.

---

## 12. Open questions (all four decided by Tico 2026-09-25 — approved as written)

1. **[APPROVED 2026-09-25] Two-person approval threshold default.** Default second-approver threshold **$1K**, pool `auto_approve_threshold` default **disabled (0)** — the pool cap is human-approved once, but every buy inside it still gets a human click in v1. Raise the auto-approve lane only after Launchabl dogfooding proves the encumbrance math under real spend.
2. **[APPROVED 2026-09-25] Brex/Ramp virtual-card integration: build in v1.** The virtual card is the one enforcement layer that survives Marketr software bugs — the entire €7,937/day lesson. Scoped to issue/attach/limit against the client's own Brex/Ramp accounts — Marketr never sees PANs, only refs.
3. **[APPROVED 2026-09-25] CallRail: native integration in v1.** Call data feeds the cost-per-call kill switch; client cost ~$45–55/mo.
4. **[APPROVED 2026-09-25] Self-hosted QR/pURL engine: Dub OSS, self-hosted, as the default**, abstracted behind a link-engine interface so self-hosters can swap providers — scan/click data never leaves Marketr's database. QR codes are **fully customizable** per §A1 (brand colors, logo embedding, dot/eye styles, frames with CTA, error-correction to H, PNG + SVG export, scannability-verified preview before print).
5. **License/module split** — still parked per standing decision; resurfaces pre-public/commercial distribution (the money modules are the commercial-tier candidates per MASTER-PLAN §4.2).
6. **Blip agency reseller enrollment** — free, no minimums; worth doing as Launchabl's buying path. Not a build gate.
7. **DSP seat (StackAdapt et al.)** — when aggregate client volume justifies it (Phase 7 per master plan); Marketr prepares PMP-ready plans in the meantime.
