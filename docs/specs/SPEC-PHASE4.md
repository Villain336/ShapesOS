# SPEC — Phase 4: First Paid Execution (Direct Mail)

**Status:** DRAFT — awaiting Tico's approval. No code until approved.
**Date:** 2026-09-24
**Master plan ref:** `docs/MASTER-PLAN.md` — "Phase 4 — First paid execution (2 cycles + BD in parallel)"
**Research:** `docs/phase4-research.md` (Lob, PostGrid, EDDM, Canva Connect, AdQuick — all 2026-grounded)

---

## 1. What Phase 4 builds

Three build tracks + one parked BD track:

| Track | What | Why now |
|---|---|---|
| **T1 — Mail engine** | Lob + PostGrid provider abstraction, campaign builder, approval-gated sends, tracking webhooks, cost reconciliation | Mail is the only API-native physical channel — real pass-through margin, no browser-agent fragility |
| **T2 — Creative Studio** | The central home for ALL creative and design work across Marketr, powered by Canva (design, templates, assets for every channel); v1 ships with print/mail creative + the asset library, architected so email/social templates plug in later | Creative is the bottleneck on every campaign; one studio makes it repeatable everywhere |
| **T3 — EDDM concierge** | Full workflow: route selection → counts → print spec → drop scheduling → mailhouse handoff brief → attribution | No USPS EDDM API exists — concierge is the only path, and it's a high-margin service |
| **T4 — AdQuick BD** | **PARKED.** Partnership outreach draft only, and only with Tico's explicit authorization | Nothing public on terms/minimums; genuinely outreach-gated |

### The core design decision (from brainstorm)

**Direct mail is built as a first-class R3 nurture channel, not a standalone module.** Postcard/letter steps live inside nurture sequences alongside SMS/email, riding the Phase 3 infrastructure already proven: consent states, quiet hours (adapted → in-home windows), daily caps, C3 manual approval, per-send metering, and the audit log. The differentiator holds: *"We don't just find leads, we prove which ones paid"* — now across every channel including the mailbox.

---

## 2. User flows

### F1 — Connect a mail provider (Settings → Channels → Direct Mail)
1. User picks Lob or PostGrid.
2. Enters **test** API key first. System validates via provider's test endpoint, shows "Test mode — nothing will physically mail."
3. Live key entry is env-gated and visually fenced (red banner: "LIVE — real postage"). Live keys never touch the fake/test paths.
4. Connection health check + webhook endpoint registration instructions.

### F2 — Design creative (Creative Studio, `/dashboard/studio`)
**Studio is the central home for all creative and design work across Marketr, powered by Canva.** Phase 4 v1 ships it with the asset library + print/mail creative; the architecture must accept future channel templates (email, social) without rework.
1. User picks format track — **Addressed** (4×6 postcard, #10 letter) or **EDDM flat** (min 6.125"×11.5"; 4×6 does NOT qualify for EDDM — enforced in UI). Format tracks are extensible for future channel templates.
2. Three creative paths:
   - **Canva (connected):** OAuth via Canva Connect. Lists brand templates; **Autofill API** populates template with campaign data (Enterprise tenants). Export via Exports API → **PDF Print**. *(Constraint: autofill requires Canva Enterprise; PDF bleed/crop/CMYK flags via API unverified — verify in build, fall back to GUI download path if missing.)*
   - **Canva (no Enterprise):** design-link round-trip — "Open in Canva" deep link, user designs, pastes back the share/export link; Marketr pulls the PDF Print export.
   - **Upload:** user uploads print-ready PDF; system validates size, page count, and dimensions against the format track.
3. Creative is versioned, hash-stamped, and bound to the approval record (same creative-hash binding as the media-buying rules).

### F3 — Build a mail campaign (`/dashboard/nurture`, mail step or standalone)
1. Audience: pick CRM segment, prospect list, or CSV upload with addresses.
2. **Address verification:** runs through provider verification (PostGrid: free/included; Lob: paid add-on — cost shown upfront). CASS-valid; NCOA-changed addresses flagged. Unverifiable addresses are quarantined, not silently mailed.
3. Creative: pick from Studio.
4. **Cost estimate before anything sends:** per-piece provider cost × quantity + verification fees + Marketr margin preview. Shown as a line-item estimate the user approves.
5. Schedule: in-home window targeting (mail date minus USPS transit estimate), not quiet-hours — physical mail has days of latency, so timing semantics are date-based.
6. **C3 approval gate** (mandatory, same as SMS/email): human approves audience + creative hash + exact spend. Approval binds creative hash, piece count, and max spend.

### F4 — Triggered sends (R3 integration)
1. Nurture sequence step of type `postcard`/`letter`: on enrollment reaching the step → render (merge fields) → approval (per-run or pre-approved template) → queue → provider send in test or live mode → advance.
2. Speed-to-lead and missed-call flows can include a mail step (e.g., "sorry we missed you" postcard) — same engine, different latency.

### F5 — Tracking & attribution
1. Every piece gets a **QR + pURL** (reuses the Phase 2 Physical Attribution Kit: `fall-offer`-style slugs).
2. Provider webhooks (Lob scan events; PostGrid JWT-signed events) ingested with **idempotency keys** — duplicate deliveries collapse.
3. Delivery events + QR scans + redemptions flow into the existing attribution ledger: mail touch → lead → revenue, same linear multi-touch model as Phase 3.

### F6 — EDDM concierge (full workflow, `/dashboard/mail/eddm`)
1. Pick ZIP(s) → carrier-route picker (route counts from USPS EDDM data; manual entry v1, mailhouse-verified).
2. Counts → print spec (EDDM flat format enforced) → **cost estimate** (postage $0.26/pc retail 2026 + print/prep).
3. Drop scheduling → generates the **mailhouse handoff brief** (PDF): routes, counts, creative file, in-home target, facing-slip instructions.
4. Execution is human/mailhouse (no API exists). Marketr tracks status, costs, and attribution (dedicated QR/pURL per drop).
5. v1 programmatic assist: Click2Mail API evaluated as an optional send path if Tico wants one — default is concierge.

### F7 — Cost reconciliation (`/dashboard/billing` extension)
1. Every piece, verification lookup, and EDDM cost is metered at send time (estimate) and reconciled against provider invoice/webhook actuals.
2. Monthly reconciliation report: ledger vs provider invoice, variance flagged.

---

## 3. Data model (new tables)

- `mail_providers` — workspace_id, provider (lob|postgrid), test_key_ref, live_key_ref, mode, webhook_secret, health
- `mail_creatives` — workspace_id, name, format_track (addressed|eddm), size, pdf_url, creative_hash, canva_design_id, version
- `mail_campaigns` — workspace_id, name, provider_id, creative_id, audience_source, piece_count, est_cost_cents, status (draft|pending_approval|approved|sending|complete|cancelled)
- `mail_pieces` — campaign_id, lead_id (nullable), address_snapshot, verification_status, provider_piece_id, qr_slug, status, sent_at, delivered_at
- `mail_webhook_events` — provider, event_id (idempotency key), payload, processed_at
- `eddm_orders` — workspace_id, zips, routes JSON, piece_count, mailhouse, brief_pdf_url, status, cost_cents
- `mail_approvals` — binds campaign_id → creative_hash + piece_count + max_spend_cents + approver + decided_at (C3 pattern)

All tables workspace-isolated. No live key material in logs.

---

## 4. Provider abstraction

```ts
interface MailProvider {
  verifyAddress(addr): Promise<VerificationResult>  // CASS; NCOA flag where available
  estimateCost(spec): Promise<LineItem[]>           // per-piece + fees, pre-send
  sendPiece(piece, opts): Promise<{ providerPieceId }>  // test key = render only
  cancelPiece(id, window): Promise<void>
  parseWebhook(req): Promise<MailEvent[]>          // normalized delivery events
}
```

- Implementations: `FakeMailProvider` (default dev), `LobProvider` (`@lob/lob-typescript-sdk`), `PostGridProvider` (`postgrid-node-client`).
- **Dev default: PostGrid test key** — free tier, no monthly fee, and webhook simulation in test mode (Lob doesn't advertise this).
- **Scale default: Lob** — better docs/SDK, tier pricing wins above ~$550/mo spend.
- Stop-at-first-success is NOT used here (unlike enrichment waterfall) — the user picks one provider per campaign; the abstraction exists for portability and margin comparison.

---

## 5. MVP scope

**In:**
- T1: provider abstraction (fake + Lob + PostGrid), test-mode-first; campaign builder; C3 approval binding creative hash + count + max spend; QR/pURL per piece; webhook ingestion with idempotency; cost estimate + metering + reconciliation report
- T2: Creative Studio v1 as the central creative hub — asset library, Canva OAuth + template list + autofill (Enterprise) + PDF Print export; design-link round-trip fallback; PDF upload with format validation; versioning + creative hashes; channel-template architecture ready for email/social later
- T3: EDDM concierge full workflow — route picker (manual-entry v1), counts, print spec, cost estimate, drop scheduling, mailhouse handoff brief PDF, status tracking, per-drop attribution
- R3 integration: postcard/letter as nurture sequence steps + triggered sends
- Exit gates: mail battery in test mode (3× runs), webhook idempotency proofs, ledger-vs-invoice reconciliation proof

**Out (non-goals):**
- Live sends without explicit per-campaign approval (money rule — standing)
- Streaming NCOA API (doesn't exist publicly; USPS NCOA 3.0 noted as future path)
- White-label embedded Canva editing (Connect API doesn't allow it)
- AdQuick API buying (Phase 5, and only if BD lands)
- Click2Mail send path in v1 (evaluate post-launch)
- International mail

---

## 6. Monetization (per master plan §4)

- **Hosted:** provider COGS passed through **at margin** — plan's working model is ~2–3× API cost on mail pieces, verification at pass-through + margin; EDDM concierge as a service fee + postage pass-through.
- **Self-hosted:** bring your own Lob/PostGrid/Canva keys; Marketr charges nothing on postage.
- Metering reuses the Phase 3 credit ledger; mail has its own per-piece pricing table (populated from live provider estimates, not hardcoded).

---

## 7. Compliance & safety

- **Money rules (standing):** test keys default; live mode fenced; every live campaign needs explicit approval binding exact max spend; no autopilot spend, ever.
- **Address consent:** physical address on file + mail opt-out honored (opt-outs suppress queued pieces, same as SMS/email).
- **No deceptive mail:** creative approval covers content; no impersonation of government (USPS) markings — enforced in Studio review checklist.
- Webhook endpoints: signature-verified (PostGrid JWT; Lob signature), idempotency keys, replay-safe.

---

## 8. Success metrics / exit gates

1. Mail battery green 3× consecutive runs against provider test modes (campaign → approval → render → webhook simulation → attribution).
2. Webhook idempotency proof: duplicate + out-of-order deliveries collapse to one ledger entry.
3. Cost reconciliation: ledger estimate vs provider actuals within rounding on a 500-piece test run.
4. EDDM: one full concierge brief generated end-to-end (routes → brief PDF) on demo data.
5. TypeScript clean, production build green, M11 security battery green, commit-diff secret scan clean.

---

## 9. Open questions

1. **AdQuick BD outreach** — parked. Needs Tico's explicit authorization before any contact. (Resurfaced per his "save for when most important" rule — Phase 4 is that moment; he hasn't authorized yet.)
2. **Canva PDF export flags** (bleed/crop marks/CMYK) via API — unverified; build will probe and fall back to GUI download path.
3. **Canva Connect rate limits / usage costs** — nothing public; Enterprise plan is the known gate.
4. **Exact per-piece pricing** — tier-dependent; re-verify at contracting. Estimates always shown pre-send.
5. **License/module split** — still parked for pre-public/commercial distribution per standing decision.
