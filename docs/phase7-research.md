# Marketr Phase 7 — Research Brief: The Flywheel + Public Launch

**Date:** 2026-09-25. All sources 2026-current, dated inline. No vendor was contacted.
**Deep dives:** `/tmp/phase7-track1-ctv.md` (CTV), `/tmp/phase7-track2-dsp.md` (DSP),
`/tmp/phase7-track3-cro.md` (CRO), `/tmp/phase7-track4-realloc.md` (reallocation),
`/tmp/phase7-track5-opencore.md` (open-core map).

**Locked decisions from the user (do not re-litigate):**
1. Open-core vs. commercial split is DEFERRED — this brief maps options only, no recommendation.
2. Budget reallocation ships in BOTH modes: (a) propose-only, and (b) bounded guardrail
   execution inside a human-signed standing approval. Every dollar stays human-signed;
   mode (b) is pre-signed authority with explicit bounds (like Phase 5's pre-approved
   pools), never standing autonomous authority. §3.1 money rules are structural invariants.
3. CTV/commercials: BUILD the buying path (not parked).
4. CRO/A-B testing: BUILD full (not deferred).

---

## Track 1 — CTV buying reality (2026)

**Headline: exactly one self-serve CTV platform ships a genuinely public, programmatic API
a small platform can use in 2026 — Vibe.co** (public API + MCP + CLI shipped Sept 2026;
plans from $500; daily budgets from $50; no minimum commitment; 500+ streaming apps).
Everything else self-serve is UI-only. (martechvibe.com, 2026-09-22)

### Per-platform verdicts (dated)

| Platform | Verdict | Access / minimums (2026) |
|---|---|---|
| Vibe.co | **API-real** | Public API + MCP + CLI (Sept 2026). Plans from $500; daily budgets from $50; CPM $15–35 |
| MNTN | **Concierge** | UI-only — no public API (vendor profile, Sept 2026). Minimums conflict: site says "no minimums," third parties report $10K/$25K tiers |
| Tatari | **Concierge** | Managed + agency self-serve; "Has API" in directories but no public docs found. ~$5K pilots |
| tvScientific | **Concierge** | Self-serve UI, no minimum, outcome-based pricing |
| Roku Ads Manager | **Concierge** | Self-serve UI, ~$500 floor, no public API; programmatic only via Roku Exchange → DSP seats |
| The Trade Desk | **API-real (gated)** | OpenTTD dev portal launched 2026-03-04, but buying API needs rep-granted partner seat; agency seats operate at 7-figure quarterly levels |
| DV360 | **API-real (gated)** | API v4 GA; needs seat via partner/reseller; ~$50K/mo direct minimum |
| Amazon DSP | **API-real (gated)** | Self-service minimum removed Nov 2025; practical floor $5–10K/mo; managed $35–50K/mo. Prime Video STV is the prize inventory |
| Samsung Ads | **Not feasible** | Programmatic only via TTD/DV360 seats |
| LG Ads Solutions | **Not feasible** | Via Viant / Amazon DSP / Magnite only — no buyer API |
| Magnite | **Not feasible** | Sell-side; buyer-agent layer announced 2026 — watch, don't build on |
| Basis / Choozle / StackAdapt | **API-real (gated)** | Agency DSPs with APIs; partner onboarding required |

### Buildable v1 path (recommended)
1. **Vibe API adapter** — the only true programmatic buy path. Test-mode default, honest
   not-configured errors, per-buy approval objects, autopilot drafts but never executes (§3.1).
   Caveat: API is weeks old — version-pin aggressively, verify docs at build time.
2. **Concierge IO workflow** for MNTN / Roku / Tatari / tvScientific / DSP-seat paths:
   Marketr prepares the IO + creative brief, a human places the buy, Marketr reconciles.
   Explicit UI copy: "Marketr cannot pause this buy — alerts only."
3. **Creative spec validator** — ffprobe checks (1920×1080, :15/:30, H.264, -23 LUFS),
   blocks non-compliant creative (IAB Dec 2025 draft standards).
4. **Per-spot QR/pURL kit** — extends Phase 5's self-hosted QR/pURL engine; unique dynamic
   QR + pURL per placement. QR-on-TV best practice (≤3-tap landing) maps directly onto it.
5. **CTV attribution layer** — impression pixels, view-through windows, QR scan attribution,
   geo-holdout planner. Attribution must be presented as layered/probabilistic; 73% of
   advertisers rank CTV measurement as their top challenge (IAB, via PubMatic/MNTN 2025-10-13).
6. **Bring-your-own-seat adapters** (TTD / DV360 / Amazon DSP) — fail closed without a seat.
Suggested order: validator → QR kit → concierge → Vibe adapter → attribution → seat adapters.

### What v1 honestly cannot do
One-click buying across Roku/Samsung/LG inventory; deterministic CTV ROAS (never present
it as deterministic); autopilot spend; supply-path guarantees on MNTN (2026 forensic-audit
allegations exist — do not repeat "direct premium" claims as Marketr's own).

---

## Track 2 — DSP seat economics (2026)

| DSP | Cost | Minimum | Realistic path for a small platform |
|---|---|---|---|
| The Trade Desk | Take rate ~15–20% (FY2025 blended 21.6%, MediaPost 02/27/2026) | ~$100K/mo effective; API needs seat or partner | Partner-routed until $250K+/mo aggregate |
| DV360 | ~7–15% platform fee | ~$25–50K/mo (~$400K/yr); via Google sales or authorized reseller | Reseller sub-seat at $50–250K/mo aggregate |
| Amazon DSP | ~15–20% fee | Managed $50K/mo; self-service floor removed Nov 2025, practical $5–10K/mo | Self-service via console — lowest-friction "seat" |
| Yahoo DSP | $5–10K/mo tech fees | Sales-led, no white-label | Secondary |
| StackAdapt | ~15% in CPM, $0 platform fee | $500 deposit, no monthly minimums | Self-serve partner rail |
| Basis | ~$1K/mo license + 10–15% | Partner onboarding | Agency DSP option |
| Epom white-label | $250/mo starter | Zero spend minimums, per-client CPM markups | Cheap brand control for agencies |

**Volume tripwires:** <$20K/mo aggregate → no DSP at all; $20–50K → self-serve rails
(StackAdapt / Amazon self-service); $50–250K → managed tier (DV360 reseller, Amazon agency
seat, TTD stays partner-routed); >$250K sustained → direct TTD seat; >$500K → multi-DSP
(Phase 8+ problem). A direct seat beats a partner when saved partner markup (10–20 pts)
exceeds the seat's fixed costs.

**Build-readiness (seat-agnostic, build regardless of DSP):** campaign/line-item model with
the DSP as a plug-in adapter; margin accounting ledger (client-billed spend, platform fees,
passthroughs, Marketr margin as distinct lines — never commingle); versioned fee-schedule
registry; approval-object ↔ DSP budget-cap mapping; kill-switch ↔ platform pause-API mapping
(Phase 5's fake no-ops become real per-platform calls). **Structural invariant:** DSP
contracts and billing sit with the agency/client entity, never Marketr — consistent with
zero-custody. Marketr is orchestration, approval, kill-switching, margin accounting.

---

## Track 3 — CRO/A-B testing (2026)

**Verdict: embed GrowthBook's OSS stats core and build Marketr-native everything the user
touches.** GrowthBook 2026 verified: open-core, bulk MIT, ~7.8K stars, Bayesian-default
stats engine with sequential testing + SRM checks. Enterprise-locked (do NOT copy into
AGPLv3 Marketr): visual A/B editor, CUPED, SSO, advanced targeting — verify the boundary
at build time, it has moved before.

Why not pure build or a vendor: homegrown stats silently kill trust (peeking inflates
false-positive rates to 20–30% on daily-checked fixed-horizon tests); VWO/Convert
per-client pricing is hostile to agency bundling; Unleash/Flagsmith are flags-only.

**SMB stats reality (computed 2026-09-25, 80% power):** a 5k-visitors/mo site at 2%
baseline needs ~8.4 months to detect a 20% lift — v1 must refuse small-tweak tests there
and say "you can only detect ≥X% lift with this traffic." Bayesian for decisions
(~3x more sample-efficient per codecentric's GrowthBook evaluation), frequentist as
defensibility backstop; peek-safe-by-construction via always-valid sequential inference,
never fixed-horizon p-values.

**Honesty contract — v1 must refuse to claim:** no "95% winner" without SRM pass
(chi-square, α=0.001, hard gate) + ≥1 full business cycle runtime + minimum sample for
the stated MDE (else INCONCLUSIVE); conversion wins require profit guardrails
(Intelligems' lesson: test profit, not conversion — mandatory); Bayesian early-reads
gated on expected loss + minimum data, not posterior probability; secondary metrics
FDR-corrected; novelty effects disclosed.

**v1 architecture:** web via GrowthBook SDK; email tests native (Marketr owns nurture
sends); ad creative via platform-native experiments with Marketr holding the hypothesis
and importing results; direct-mail creative via Phase 4 — a genuine differentiator
nobody in the comparison set offers SMBs. Build native test lifecycle, PIE/ICE ideation
fueled by Phases 2–6 data, code/URL variants; defer visual editor to v2 (deliberately —
it's the vendors' moat); every closed test archives to Growth Memory.

---

## Track 4 — Budget reallocation agents

**Landscape:** Skai's AI budget allocation is the closest enterprise reference (assisted →
autonomous stepwise delegation, 2026 Measurement Hub with iROAS/profit/LTV). MarinOne and
Metadata.io do AI allocation with CRM feedback loops. Industry default is NOT full
autonomy: Nylas early-2026 research (n=1,026) found only 4% of teams let agents act
without human approval. Platform-native optimizers (Meta CBO, Google PMax) are black boxes
you can't constrain — that's the gap a cross-platform agent fills.

**Documented failure modes to guard against:** learning-phase doom loops (>20% budget
changes reset 7–10 day learning phases); attribution-lag whiplash (April 2026 GA4
recalibration moved credit with zero real change); measurement outages masquerading as
performance; dayparting traps; last-click starvation of upper funnel; brand-term
cannibalization inflating reported ROAS; scale-induced ROAS collapse; black-box
unaccountability (auditors require what-data/what-logic/what-version/who-approved).

**Methodology (recommended):** marginal-ROAS equalization on per-channel diminishing-returns
curves (Hill/power/log-log, Robyn-style MMM precedent) — NOT greedy last-click ranking.
Lag handling via data-maturity delays + multi-window agreement + measurement-health
pre-check that freezes on data breakage. Anti-churn: minimum meaningful shifts, ≤20% per
step, 72h cool-downs, stabilization windows, a fixed 70-20-10 exploration slice the
optimizer can't touch, brand spend segmented out of marginal-ROAS math.

**Mode (b) safety architecture:** three-plane separation — Optimizer (proposes) →
deterministic Policy Engine (authorizes, LLM-proof, OPA-style) → Phase 5 Executor
(re-verifies at checkout). Mode (b) exists only under a human-signed **Standing
Reallocation Approval (SRA)**: channel allowlist, per-shift cap ≤ $1,000 (two-person
≥ $1,000, cumulative too), daily/weekly aggregate caps (e.g., ≤15% / ≤25% of pool),
±10% per-channel band (user-ordered default), mandatory expiry ≤30d, 72h cool-downs,
exploration floor, revocation handle. Timeout = deny; revocation is instant via
checkout-time re-verification; breakers are one-way ratchets (CPA stop-loss,
spend-velocity, measurement-health, error-rate, attribution-regime) that can only
pause, never authorize spend; mandatory human-acknowledged cool-down after any breaker.
Immutable replayable audit log of every proposal, policy decision, execution, and
breaker event. Mode (a) propose-only reuses the same pipeline with per-move human
approval materialized as standard Phase 5 per-buy approval objects.

**Open spec questions:** per-channel learning-viable floor formula; confirm SRA defaults;
incrementality source (built-in vs. ingested); v1 reallocates only *between* platform
campaigns, not inside PMax/Advantage+ black boxes (recommended).

---

## Track 5 — Open-core launch options (map only — decision deferred)

**Precedents (2026):** GitLab CE/EE, Mattermost, Plausible (AGPLv3 CE vs Cloud —
funnels + ecommerce tracking are the premium layer), Matomo (heatmaps/recordings/A-B
testing + white-label as paid plugins), Mautic (100% open), n8n (fair-code; SSO/RBAC/
audit gated), authentik (gates only compliance logging), SeasAGI (2026 3-way
GPL/AGPL/BSL split). **Legal flag:** OnlyOffice "Logo Trap" (Apr 2026 opinion) —
AGPLv3 §7 additional permissions + trademark is the tested mechanism for protecting
the brand/white-label boundary. What marketing OSS gates: white-label/agency features
(most common), team governance, managed data/ops, AI features with marginal cost,
premium integrations, compliance artifacts. Cross-vendor rule: the open tier must be a
complete product, not a crippled demo.

**Four split options (no recommendation):**
- **A — Open Everything** (Ghost/Mautic pole): all code AGPL; commercial = white-label
  license + hosted + support. Max trust; the license must carry the business alone.
- **B — AGPL Core + Closed Enterprise Pack** (GitLab/n8n pole): open = core OS;
  commercial = SSO/RBAC/audit, white-label sub-accounts, premium integrations,
  compliance. Proven; needs CLA + published boundary doc in CONTRIBUTING.md.
- **C — Three-Layer GPL/AGPL/Closed** (SeasAGI pattern): GrowthOS orchestrator closed.
  Finest IP protection, highest complexity.
- **D — AGPL Everything + Lagged/Cloud-Premium** (Plausible pole): no closed code;
  Cloud wins on cadence + managed keys. Simplest legally, weakest fork defense.

**Cross-cutting points for the later call:** CLA-vs-DCO must be settled *before* going
public under B/C; where AI marginal spend sits; white-label via §7 + trademark vs.
license terms; the highest-stakes line — GrowthOS orchestrator open (A/D) or
commercial (B/C). **Launch mechanics mapped:** full repo-hygiene checklist (secret
history scan + rotation, license audit, community files, CI on clean clone), Product
Hunt 2026 playbook (12:01 AM PT Tuesday, 14-day timeline, never solicit upvotes —
comment quality + first-4-hour velocity; ~450–600 upvotes target), README/docs bar
for an OSS marketing OS.

---

## §6 — Recommended v1 scope

**F1 — Budget reallocation agent (both modes).** Marginal-ROAS optimizer → deterministic
Policy Engine → Phase 5 executor machinery. Mode (a) propose-only ships with per-move
human approval; mode (b) ships behind the signed SRA envelope with ±10% band default,
$1k two-person cumulative threshold, 15%/25% daily/weekly caps, ≤30d expiry, one-way
circuit breakers, immutable audit log, instant revocation. Reallocates only between
platform campaigns in v1 (never inside PMax/Advantage+).

**F2 — Creative recycling pipeline.** Winning creative propagates across channels:
winning mailer → billboard/DOOH variant (Phase 5 studio + QR engine), winning ad →
email/landing variant. Rules-based + supervised: every regenerated asset re-enters the
existing approval flows; nothing auto-publishes.

**F3 — Test Lab (CRO/A-B).** GrowthBook OSS stats core embedded; Marketr-native test
lifecycle, PIE/ICE ideation fueled by Phases 2–6 data, web/email/ads/mail variants,
peek-safe honesty dashboard (SRM gate, power badges, profit guardrails, auto-inconclusive),
closed tests archive to Growth Memory. No visual editor in v1.

**F4 — CTV buying path.** Creative spec validator → per-spot QR/pURL kit → concierge IO
workflow (MNTN/Roku/Tatari/tvScientific, alert-only kill switches, honest UI copy) →
Vibe API adapter (only true programmatic path; test-mode default; version-pinned) →
CTV attribution layer → bring-your-own-seat adapters (TTD/DV360/Amazon, fail closed).

**F5 — DSP readiness (no seat).** Seat-agnostic campaign/line-item model, margin
accounting ledger, fee-schedule registry, approval-object ↔ DSP cap mapping, kill-switch
↔ pause-API mapping. Follow the tripwire decision tree (StackAdapt/Amazon rails at
$20–50K/mo aggregate → DV360 reseller at $50–250K → direct TTD seat at $250K+
sustained). DSP contracts/billing stay with the agency/client entity — never Marketr.

**F6 — Public-launch readiness.** Repo-hygiene checklist, license audit, CLA/DCO settled,
community files, Product Hunt playbook staged. The split itself is NOT decided here —
the spec must present the options map for the user's later call.

---

## §7 — Open questions for the spec writer

1. SRA default calibration: confirm ±10% band, ~15% daily / ~25% weekly caps, $1k
   cumulative two-person threshold — or tighten/loosen?
2. Incrementality source: built-in geo-holdout planner only, or ingest client lift
   studies (Northbeam/Haus-style) as calibration?
3. GrowthBook embedding: vendor the OSS stats package vs. run it as a sidecar service?
4. Vibe adapter depth: campaign CRUD + pause + reporting in v1, or budget moves too
   (budget moves route through F1's reallocation machinery either way)?
5. Public-launch scope for Phase 7: repo-hygiene + staged playbook only, or actually
   flip the repo public within the phase?
