# SPEC — Phase 7: The Flywheel + Public Launch Readiness

**Status:** SPEC — APPROVED by Tico 2026-09-25 (all 5 open questions decided). Not built.
**Date:** 2026-09-25
**Master plan ref:** `docs/MASTER-PLAN.md` — "Phase 7 — The flywheel + public launch (ongoing)"; §3.1 autopilot money rules (structural invariants)
**Research:** `docs/phase7-research.md` (five tracks, all 2026-current: CTV reality, DSP economics, CRO/A-B, reallocation agents, open-core map) + deep dives `/tmp/phase7-track{1..5}-*.md`

---

## 1. What Phase 7 builds

Six build tracks, in a hard order. **Every dollar stays human-signed — that is the exit gate, not a feature.**

| Track | What | Why this order |
|---|---|---|
| **F1 — Budget reallocation agent (both modes)** | Cross-channel optimizer proposing budget shifts from attribution data; mode (a) propose-only with per-move human approval; mode (b) bounded guardrail execution inside a human-signed Standing Reallocation Approval | The flywheel's core: attribution data → budget shifts. Methodology and the deterministic policy envelope must exist before anything touches money |
| **F2 — Creative recycling pipeline** | Winning creative propagates across channels (winning mailer → billboard/DOOH variant, winning ad → email/landing variant), supervised through existing approval flows | Compounds F1: the same dollars buy better creative per channel |
| **F3 — Test Lab (CRO/A-B)** | Full experimentation platform: GrowthBook OSS stats core embedded (Bayesian + sequential + SRM), Marketr-native ideation, QA/preview, honesty dashboard, multi-channel test objects, Growth Memory archive | Generates the experiments whose outcomes the flywheel learns from; CRO was explicitly un-deferred by Tico |
| **F4 — CTV/commercials buying path** | Creative spec validator → per-spot QR/pURL kit → concierge IO workflow (MNTN/Roku/Tatari/tvScientific) → Vibe API adapter → probabilistic CTV attribution layer → bring-your-own-seat adapters | The paid channel the flywheel needs next; Vibe.co is the only API-buyable CTV platform a small platform can use in 2026 |
| **F5 — DSP readiness (no seat in v1)** | Seat-agnostic plug-in adapter model, margin accounting ledger, versioned fee-schedule registry, approval-object ↔ DSP cap mapping, kill-switch ↔ pause-API mapping, volume tripwire decision tree | Builds the rails the day aggregate volume justifies a seat; contracts/billing stay with the agency/client — never Marketr |
| **F6 — Public-launch readiness** | Repo-hygiene checklist, license/SBOM audit, community files, CI on clean clone, CLA/DCO decision staged, README/docs bar, Product Hunt playbook staged | The open-core split is DEFERRED — v1 is readiness only, no public flip |

### The core design decisions

1. **Reallocation ships in both modes, but mode (b) is a pool-cap object, not a permission slip.** Mode (a) propose-only: the agent proposes, each move is a human-approved Phase 5-style approval object. Mode (b): the agent executes only inside a human-signed **Standing Reallocation Approval (SRA)** — a cryptographically signed envelope with a channel allowlist, per-shift ≤ $1,000 (two-person ≥ $1,000, cumulative too), ~15% daily / ~25% weekly aggregate caps, ±10% per-channel band default, ≤30-day expiry, and instant revocation. This is Phase 5's pre-approved-pool model applied to budget movement: a lighter approval path with explicit bounds, never standing autonomous authority. Mode (b) is explicit opt-in per workspace and defaults to disabled.
2. **Three planes, never one.** Optimizer (LLM + diminishing-returns curves) proposes → deterministic Policy Engine (LLM-proof, OPA-style) authorizes → Phase 5 Executor re-verifies at checkout. The optimizer cannot touch money; the policy engine cannot invent bounds; the executor independently re-checks signature, cumulative caps, and revocation at execution time — not just proposal time.
3. **Marginal ROAS, not last-click.** The optimizer equalizes *marginal* ROAS across channels on per-channel diminishing-returns curves (Hill/power/log-log, adstock + seasonality) — never greedy last-click ranking, which systematically starves upper funnel and feeds brand cannibalization. Brand-capture spend is segmented out before marginal math.
4. **Breakers are one-way ratchets.** Performance, spend-velocity, measurement-health, error-rate, and attribution-regime breakers can only pause or freeze — never authorize spend. Timeout = deny; revocation = instant; a fired breaker requires human acknowledgment plus a mandatory cool-down before the optimizer may touch the channel again.
5. **v1 reallocates between platform campaigns, never inside black boxes.** PMax/Advantage+ internals are off-limits; the optimizer moves budget *between* campaigns and lets the platforms split internally.
6. **The Test Lab's stats are peek-safe by construction.** GrowthBook's OSS core (Bayesian default, always-valid sequential inference, chi-square SRM at α=0.001 as a hard gate) — because the industry data is unambiguous: daily-checked fixed-horizon tests push false-positive rates to 20–30%. The honesty dashboard refuses "95% winner" without SRM pass + ≥1 full business cycle + power for the stated MDE; profit guardrails are mandatory; the lab refuses small-tweak tests at low-traffic sites ("you can only detect ≥X% lift with this traffic"). Visual editor deferred to v2.
7. **CTV is honest about what's API and what isn't.** Vibe.co is the only true programmatic buy path (public API + MCP, shipped Sept 2026 — version-pinned, test-mode default, adapter depth = campaign CRUD + pause + reporting only in v1; budget moves route through F1). Everything else self-serve (MNTN, Roku Ads Manager, Tatari, tvScientific) is a concierge IO workflow with explicit "Marketr cannot pause this buy — alerts only" UI copy. Gated DSPs (TTD, DV360, Amazon, Basis) are bring-your-own-seat adapters that fail closed without a seat. CTV attribution is layered and probabilistic — impression pixels, view-through windows, per-spot QR/pURL (the deterministic slice), geo holdouts — never deterministic CTV ROAS.
8. **DSP contracts and billing stay with the agency/client — never Marketr.** Zero-custody extends to seats: Marketr is orchestration, approval, kill-switching, and margin accounting. The volume tripwire decision tree (<$20K/mo no DSP; $20–50K StackAdapt/Amazon rails; $50–250K DV360 reseller or Amazon agency seat; >$250K sustained direct TTD) is the productized judgment.
9. **Public launch = readiness, not launch.** The open-core split is deferred by standing decision; this spec presents the options map only. F6 executes the repo-hygiene checklist, community files, CI-on-clean-clone, staged Product Hunt playbook, and stages the CLA-vs-DCO call — but no public repo flip happens in v1.

---

## 2. Track-by-track build plan

### F1 — Budget reallocation agent (both modes)

**Methodology (the optimizer):**
- **Marginal-ROAS equalization on diminishing-returns curves.** Fit per-channel spend→response curves (Hill saturation or power/log-log, Robyn-style adstock + seasonality) on platform spend + Phase 2 attributed conversions. Marginal ROAS = the curve's derivative at current spend. Move budget from channels whose marginal $1 earns less to channels whose marginal $1 earns more until marginal returns equalize or a bound binds. Every proposal carries the decision record: data window, curve parameters, R², model version — because "the algorithm decided" is not an audit answer (2026 audit-risk consensus).
- **Lag handling (mandatory):** optimize on attribution-lagged windows (e.g., 7-day click + view with 2–3 day data-maturity delay), never on today's partials; require multi-window agreement (signal holds in both 7d and 14–28d windows); run a measurement-health pre-check before every run (event volume within expected band, platform-vs-tracker/CRM cross-source agreement) — a degraded source means **freeze**, not reallocate. April 2026's GA4 recalibration moved credit with zero real change; never reallocate on fresh attribution deltas alone.
- **Anti-churn:** no move smaller than max(5–10% of channel budget, the channel's learning-viable increment) — sub-threshold moves cost learning resets and gain noise; ≤20% of a channel's daily budget per step; 72h cool-down per channel between moves (Meta's documented scaling ladder: $100→$120→$145→$175→$210→$250); Google-managed channels respect 1–2 week stabilization. A fixed **70-20-10 exploration slice** (70% proven, 20% testing, 10% experimental) the optimizer may not touch; new channels below statistical significance live in the exploration slice until they clear a significance gate (≥50 optimization events/week).
- **Per-channel learning-viable floors:** refuse to micro-allocate below a channel's floor (below ~10× target CPA/day, campaigns can't exit learning — the optimizer would optimize noise). Floor formula: max(10× target CPA/day, platform minimum for learning exit); set per channel in workspace config.
- **Incrementality calibration:** where incrementality data exists (F3 geo-holdout results, ingested lift studies in v2), use iROAS to calibrate platform-reported curves with a per-channel calibration factor — and surface the disagreement to the human ("Meta reports 4.2×; holdout-calibrated estimate 2.6×").

**Mode (a) — propose-only:**
- Optimizer emits shift proposals with the full decision record. Each proposal lands in the human approval queue; approving it materializes a standard Phase 5 per-buy approval object (or a one-shot SRA with `window` = single execution). No standing authority exists in this mode.

**Mode (b) — bounded guardrail execution inside the SRA:**
- The **Standing Reallocation Approval** is a human-signed envelope object:

| Field | Purpose | Default |
|---|---|---|
| `channels[]` | eligible channels/campaigns — explicit allowlist only | none (must be chosen) |
| `per_shift_cap_cents` | max $ moved in one action | ≤ $1,000 (two-person ≥ $1,000, cumulative too) |
| `daily_aggregate_cap_cents` | max $ moved/day (sum of abs shifts) | ≤ 15% of pool |
| `weekly_aggregate_cap_cents` | max $ moved/rolling 7d | ≤ 25% of pool |
| `per_channel_band_pct` | floor/ceiling per channel vs. baseline | ±10% (user-ordered default) |
| `exploration_floor_pct` | protected test budget, optimizer may not touch | 10–20% |
| `cooldown_hours` | min interval between shifts on the same channel | 72h (Meta ladder); 7–14d for PMax-managed channels |
| `valid_from` / `valid_until` | effective window — expiry mandatory | ≤ 30 days, then re-sign |
| `revocation_id` | instant-revoke handle | checked on every action |
| `signer_ids` | human signatures (1 required; 2 for ≥$1k cumulative movement) | explicit |

- **The Policy Engine** evaluates every proposal against the active SRA in deterministic code (OPA/Rego-style) — not in the LLM. The optimizer can propose anything; the engine forwards only what satisfies every field. Denials are logged with reasons. **Timeout means no**: an expired, revoked, or uncheckable SRA = deny.
- **The Phase 5 Executor** re-verifies at checkout: SRA signature validity, current cumulative caps against the caps actually consumed, and revocation status — at the moment of execution, not just proposal time. Per-buy approval objects continue to cryptographically bind the actual inventory/spend/creative/dates/terms of each buy; the SRA authorizes *budget movement between channels*, never the buys themselves.
- **Mode (b) is explicit opt-in per workspace and defaults to disabled.** Creating an SRA is a deliberate act with a plain-language UX that states concrete consequences and irreversibility level, defaulting to the conservative option.

**Circuit breakers (deterministic, evaluated every run + 15-min watchdog):**
- **Performance:** channel CPA > 1.5× target AND spend > $100 AND not in learning → freeze that channel's moves.
- **Spend-velocity:** daily spend > 80% of budget before noon → alert + freeze further shifts.
- **Measurement:** event volume outside ±2σ of expected band, or platform-vs-tracker disagreement > threshold → **global freeze** of mode (b).
- **Error-rate:** consecutive policy denials or execution failures > N → pause the agent; convert the incident into a regression test.
- **Attribution-regime:** detected attribution-model/lookback change → freeze for one full stabilization window; notify the human with before/after comparison.
- All breakers are **one-way ratchets**: they can only pause/reduce autonomy, never authorize spend. After any breaker fires: mandatory ≥72h cool-down on affected channels + human acknowledgment of the incident before the optimizer may propose again.

**Audit trail:** every proposal, policy decision (allow *and* deny — approvals carry the investigative value), signature check, execution, and breaker event is appended to an immutable, replayable log with correlation IDs. **Instant revocation:** a single signed `revoke(SRA_id)` flips the envelope to denied; checkout-time re-verification makes revocation effective even mid-flight. Phase 5 kill switches halt both modes.

### F2 — Creative recycling pipeline

- **Trigger signals** come from Phases 2–6 data: revenue-influenced content (C2 attribution), high QR/pURL scan rates (Phase 5), high co-occurrence-lift sources (Phase 6 AEO), winning direct-mail response rates (Phase 4).
- **Recycling brief object:** source asset + creative-hash lineage → target channels with variant specs (e.g., winning mailer → billboard/DOOH variant via the Phase 5 studio + QR engine; winning ad → email/landing variant). Every regenerated asset **re-enters the existing approval flows** (studio review, per-buy creative binding) — nothing auto-publishes, nothing enters a buy without its own approval object.
- **Rules-based first:** deterministic adaptation rules per channel pair (aspect ratios, copy-density ceilings, CTA formats) with supervised-LLM rewrite of headlines/CTAs only where the human approves the variant. The pipeline's job is brief-generation and routing, not unsupervised art direction.

### F3 — Test Lab (CRO/A-B)

**Stats core (embedded, vendored — see §12.3):**
- Embed GrowthBook's OSS stats core: Bayesian default (Beta-Binomial for binomial metrics; Normal priors for count/duration/revenue), always-valid sequential inference (peek-safe by construction), chi-square SRM check at α=0.001 as a **hard gate** (results literally refuse to render on SRM failure: "EXPERIMENT COMPROMISED"), frequentist reported as the defensibility backstop.
- **License hygiene (structural):** GrowthBook core is MIT — safe inside AGPLv3 Marketr. Never copy anything under `packages/enterprise` (visual editor, CUPED packaging, SSO). Reimplementing CUPED-equivalents from statistics literature is a permitted v2; the packaged enterprise versions are not.
- **Integrity battery before reading results:** SRM → coverage (all randomized units present) → pre-period parity → exposure leakage → concurrent-test contamination → metric volatility. Every check runs before the dashboard renders a verdict.

**Marketr-native layers:**
- **Experiment object:** hypothesis, PIE/ICE prioritization score (fueled by Phases 2–6 data — heatmaps-equivalent signals, AEO citation gaps, ad performance), channel (web|email|ads|mail), variants, audience, primary metric, guardrail metrics (latency/error rate, bounce, unsubscribe/churn, revenue/profit), status (draft|qa|running|paused|complete|archived), traffic-floor note, minimum runtime (≥1 full business cycle, 7 days min), stated MDE.
- **Assignment:** web via GrowthBook JS SDK (self-hosted manifest from Marketr; local evaluation, no per-check HTTP); email via Marketr's native splitter in nurture sends (Phase 3 infra — subject/content variants); ads via platform-native experiments with Marketr holding the hypothesis and importing results (don't re-run ad delivery); direct mail via Phase 4 split drops — a genuine differentiator nobody in the comparison set offers SMBs.
- **QA/preview:** force-QA links, cookie preview, A/A dry-run validation before launch.
- **Honesty dashboard:** peek-safe decision boundaries (never "significance"); power/maturity badges; profit guardrails mandatory on conversion tests (the Intelligems lesson: test profit, not conversion — a conversion lift with a 15% discount is a loss); Bayesian early-reads gated on expected-loss thresholds + minimum data, never posterior probability alone; secondary metrics and exploratory slices FDR-corrected or labeled exploratory; novelty/primacy effects disclosed as provisional until the full cycle completes.
- **Traffic-floor honesty:** the lab **refuses** small-tweak tests at low-traffic sites — it states the minimum detectable effect the traffic can support ("you can only detect ≥X% lift with this traffic") and suggests qualitative methods or big swings instead. (Reference math, 80% power: a 5k-visitors/mo site at 2% baseline needs ~8.4 months to detect a 20% lift.)
- **Visual editor deferred to v2** — deliberately; it is the vendors' moat and GrowthBook's enterprise line.
- **Growth Memory sink:** every closed test archives a structured learning (hypothesis, result, effect size, CI, segment notes, suggested follow-ups) into the Phase 8 Growth Memory interface — build the sink against a forward-compatible schema; Phase 8 defines the store.

### F4 — CTV/commercials buying path

Build in this order: validator → QR/pURL kit → concierge IO → Vibe adapter → attribution → seat adapters.

**Creative spec validator (build first):**
- ffprobe-based checks against IAB Tech Lab Dec 2025 draft standards: 1920×1080, :15/:30 (6/15/30/45/60 accepted), MP4 H.264, bitrate within ready-to-serve bands, stereo audio at **−23 LUFS** integrated / 48 kHz, no slates/countdowns, no letterboxing/pillarboxing. Publisher-specific rules table (Tubi, etc.). **Blocks submission of non-compliant creative** — cheap to build, high trust value.

**Per-spot QR/pURL kit:**
- Extends the Phase 5 self-hosted QR/pURL engine: unique **dynamic** QR + pURL per placement (show genre, daypart, demo — scan-rate variance is large). QR sized for couch-distance scanning; landing pages must complete in **≤3 taps**. Scan analytics feed the attribution layer and F2's recycling signals.

**Concierge IO workflow:**
- For MNTN, Roku Ads Manager, Tatari, tvScientific: Marketr generates the IO + creative brief (audience, geo, budget, flight, spec sheet); the human places the buy in the vendor UI; states: `draft → human-placed → live → reconciling`. **Explicit UI copy: "Marketr cannot pause this buy — alerts only."** Models "pending vendor approval" as a first-class state (managed services add days — buys are not instant). No API = no programmatic guardrails: reconciliation happens via pixel + QR/pURL + platform report import, and Marketr *alerts* the human to pause.
- Honesty notes surfaced in-product: MNTN minimums conflict in 2026 sources (site says "no minimums," third parties report $5K–$25K tiers — verify at build); 2026 forensic-audit allegations about MNTN supply paths — do **not** repeat "direct premium" claims as Marketr's own.

**Vibe API adapter (the only true programmatic path):**
- Vibe.co public API + MCP (shipped Sept 2026): campaign CRUD + **pause** + reporting. Test-mode default; honest not-configured errors without creds; **version-pinned aggressively** (the API is weeks old — verify docs at build time). Every spend action behind a Phase 5 per-buy approval object; autopilot drafts, never executes (§3.1).
- **v1 adapter depth: campaign CRUD + pause + reporting only.** Budget moves route through F1's reallocation machinery — not through the adapter [§12.4].

**CTV attribution layer:**
- Impression-pixel generator/hosting; view-through windows; QR/pURL scan attribution (the deterministic slice); branded-search-lift report template (post-flight); geo-holdout planner for incrementality tests. Presented as **layered and probabilistic** — 73% of advertisers rank CTV measurement as their top challenge (IAB via PubMatic/MNTN, 2025-10-13). Never present deterministic CTV ROAS.

**Bring-your-own-seat adapters (fail closed):**
- TTD (OpenTTD, seat required), DV360 (API v4, seat required), Amazon DSP (API, certification/seat required), Basis. If no seat: fail closed with "connect your agency seat" setup guidance. Same approval-object gating as Vibe.

### F5 — DSP readiness (no seat in v1)

- **Seat-agnostic campaign/line-item model:** the DSP is a plug-in adapter behind a stable internal interface; Phase 7 builds the model and the interface, not the seats.
- **Margin accounting ledger:** client-billed spend, platform fees, passthroughs, and Marketr margin as **distinct lines — never commingled** (MASTER-PLAN §3.3). This is where the agency proves its take is clean.
- **Versioned fee-schedule registry:** per-DSP fee lines (take rates, tech fees, minimums) versioned over time so margin math is auditable against the schedule that was live when the spend happened.
- **Approval-object ↔ DSP cap mapping:** Phase 5 approval objects map onto DSP-level budget caps so a human-signed cap is enforceable at the platform; **kill-switch ↔ pause-API mapping:** Phase 5's per-platform kill-switch actions become real pause calls wherever an adapter with a seat exists (the fake no-ops get real targets).
- **Volume tripwire decision tree (productized judgment):** <$20K/mo aggregate → no DSP; $20–50K → self-serve rails (StackAdapt, Amazon self-service); $50–250K → managed tier (DV360 reseller, Amazon agency seat, TTD stays partner-routed); >$250K sustained → direct TTD seat; >$500K → multi-DSP (Phase 8+ problem). A direct seat beats a partner when saved partner markup (10–20 pts) exceeds the seat's fixed costs.
- **Zero-custody (structural):** DSP contracts and billing sit with the agency/client entity — never Marketr. Marketr is orchestration, approval, kill-switching, and margin accounting.

### F6 — Public-launch readiness

- **The open-core split is NOT decided in this phase** (deferred by standing decision — §12.5). F6 executes readiness; the options map (A: open everything, B: AGPL core + closed enterprise pack, C: three-layer, D: AGPL everything + cloud premium — per `docs/phase7-research.md` Track 5) ships as a decision brief, not a recommendation.
- **Security pre-flight (do first):** full-history secret scan (gitleaks/trufflehog) across all branches and commits — DataForSEO keys, LLM provider keys, Smartlead/Instantly, Brex/Ramp, Stripe, AWS/CF tokens, admin passwords. **Any hit → rotate the secret AND scrub history (BFG/git-filter-repo) before any public push — you cannot un-leak.** Verify `.gitignore` covers `.env*`, `*.pem`, `*.key`, pgdata, logs; workflows reference `secrets.*` only; strip internal PII (emails, names, internal URLs, real client data in fixtures/seeds); audit demo/seed data for real campaigns or spend figures.
- **Legal & license:** canonical unmodified AGPLv3 LICENSE at root; `package.json` license field matches; copyright holder identified (required for the commercial re-licensing path); THIRD_PARTY/SBOM audit of every dependency for AGPL-compatibility (GPL-incompatible or proprietary deps poison the dual-license story); commercial-license terms page drafted so the public repo doesn't read as a trap; trademark note — decide whether "Marketr" branding is protected via AGPLv3 §7 additional permissions (the OnlyOffice "Logo Trap" 2026 precedent).
- **Community files:** CONTRIBUTING.md (PR guidelines, dev setup, verification steps, **CLA-or-DCO statement**, and the open-vs-commercial feature boundary — the authentik lesson: publish what contributors should and shouldn't build before they code); SECURITY.md (private reporting channel, response SLA, scope); CODE_OF_CONDUCT.md; issue + PR templates; CHANGELOG/release discipline; `.env.example` with placeholders for every env var.
- **Build confidence for strangers:** CI green on a clean clone; E2E smoke test that passes without private credentials (mock mode / graceful skips); self-host quickstart that reaches a running instance in <10 minutes.
- **README/docs bar:** one-line tagline + 3-bullet what-it-does + hero screenshot + badges above the fold; clear open-vs-commercial table (Plausible-style); docs site (install, config, architecture, API reference, licensing page); 3–5 real-UI screenshots; public roadmap file.
- **CLA vs DCO flagged as must-decide-before-public:** dual-license (AGPLv3 + commercial white-label) requires either a CLA granting re-licensing rights or a policy that commercial-only code is company-authored. Settle this before the repo goes public — not after.
- **Product Hunt playbook staged:** 12:01 AM PT Tuesday launch, 14-day prep timeline, never solicit upvotes (comment quality + first-4-hour velocity decide), ~450–600 upvote target band.

---

## 3. Key flows

- **R1 — Mode-(a) shift (propose-only):** attribution snapshot → optimizer fits curves → proposes shift plan with decision record → human approval queue → approval materializes per-buy approval object → Phase 5 executor re-verifies at checkout → spend moves between platform campaigns → audit log.
- **R2 — Mode-(b) shift (SRA envelope):** same pipeline, but the Policy Engine authorizes against the active SRA instead of a per-move human click: proposal → envelope checks (allowlist, caps, band, cool-down, revocation) → allow/deny logged → executor re-verifies signature + cumulative caps + revocation at execution → move. Any field violation = deny + log + alert.
- **R3 — Breaker trip:** watchdog or run detects performance/velocity/measurement/error/regime condition → one-way ratchet fires (freeze in scope) → incident logged → human must acknowledge + mandatory cool-down elapses → optimizer may propose again. Breakers never authorize anything.
- **R4 — SRA lifecycle:** human configures envelope (plain-language consequences, conservative defaults) → signs (1 signer; 2 for ≥$1k cumulative movement) → active with ≤30d expiry → instant `revoke(SRA_id)` possible at any time → expired/revoked = timeout-means-no (mode b ceases to exist).
- **R5 — Recycling brief:** attribution/QR/AEO signals flag a winner → brief generated (source asset, creative-hash lineage, target channels, variant specs) → human approves → studio regenerates variants → variants enter standard approval flows → bound to per-buy creative hashes.
- **R6 — Experiment lifecycle:** ideation (PIE/ICE, fueled by Phases 2–6 data) → traffic-floor honesty check (refuse or right-size) → QA/preview (force-QA, A/A dry-run) → launch → peek-safe monitoring → verdict (SRM gate, full business cycle, power, profit guardrails) → structured learning archived to Growth Memory sink.
- **R7 — CTV Vibe buy:** creative validated by ffprobe → per-spot QR/pURL minted → per-buy approval object signed → Vibe adapter creates/launches (test-mode unless creds) → pause available via API → attribution pixels + QR scans reconcile → view-through + search-lift reported probabilistically.
- **R8 — Concierge CTV buy:** validator + QR kit as above → IO + creative brief generated → human places buy in vendor UI (`human-placed`) → Marketr reconciles via pixel/QR/platform reports → alerts only on kill-switch conditions.
- **R9 — DSP tripwire review:** aggregate spend crosses a tripwire band → tripwire report recommends a rail (or no DSP) with the fee-schedule math → human decides → adapter connected or deferred; margin ledger lines stay distinct throughout.

---

## 4. Data model

Workspace-isolated throughout. New tables (23):

**F1 — Reallocation:**
- `sra_envelopes` — id, workspace_id, name, channels[] (allowlist), per_shift_cap_cents, daily_aggregate_cap_cents, weekly_aggregate_cap_cents, per_channel_band_pct, exploration_floor_pct, cooldown_hours, valid_from, valid_until (≤30d), revocation_id, status (active|revoked|expired), signer_ids[], signature_hash, created_by
- `reallocation_proposals` — id, workspace_id, mode (a|b), sra_id?, source_channel, dest_channel, amount_cents, marginal_roas_delta, curve_version, data_window, model_version, status (proposed|policy_approved|policy_denied|human_approved|executed|rejected), human_approval_id
- `policy_decisions` — id, proposal_id, decision (allow|deny), reasons[], sra_id, revocation_checked_at
- `marginal_curves` — id, workspace_id, channel, curve_type (hill|power|loglog), params JSON, adstock_params, seasonality, r_squared, data_window, iroas_calibration_factor?, fitted_at, model_version
- `channel_floors` — workspace_id, channel, learning_viable_min_cents_day, stabilization_hours
- `reallocation_runs` — id, workspace_id, run_at, mode, proposals_count, executed_count, denied_count, frozen, data_health_snapshot
- `breaker_events` — id, workspace_id, breaker_type (performance|velocity|measurement|error_rate|attribution_regime), scope, fired_at, acknowledged_by, acknowledged_at, cooldown_until

**F2 — Recycling:**
- `recycling_briefs` — id, workspace_id, source_asset_id, source_channel, trigger_signal, target_channels[], variant_specs JSON, creative_hash_lineage[], status (draft|approved|regenerating|ready), approval_id

**F3 — Test Lab:**
- `experiment_ideas` — id, workspace_id, title, source_signal (phase2..6 reference), pie_ice_score, status
- `experiments` — id, workspace_id, name, hypothesis, pie_ice_score, channel (web|email|ads|mail), variants[], audience, primary_metric, guardrail_metrics[], status (draft|qa|running|paused|complete|archived), traffic_floor_note, min_runtime_days, stated_mde, verdict (winner|loser|inconclusive|compromised)
- `experiment_results` — id, experiment_id, stats JSON (prob_to_beat, expected_loss, sequential_ci, frequentist_p), srm (pass|fail, chi2_p), guardrail_checks[], verdict, archived_to_memory

**F4 — CTV:**
- `ctv_campaigns` — id, workspace_id, platform (vibe|mntn|roku|tatari|tvscientific|seat:ttd|seat:dv360|seat:amazon|seat:basis), mode (api|concierge), status, approval_object_id
- `ctv_creative_validations` — id, creative_id, ffprobe JSON, pass, publisher_rules_version
- `ctv_spots` — id, campaign_id, placement_label, creative_id, qr_id, purl_id, flight_from, flight_to
- `ctv_ios` — id, campaign_id, io_payload JSON, state (draft|human_placed|live|reconciling), placed_by
- `ctv_pixels` — id, campaign_id, pixel_url, view_through_window_days

**F5 — DSP:**
- `dsp_adapters` — id, workspace_id, dsp, seat_status (none|pending|connected), config_ref (vault)
- `fee_schedules` — id, workspace_id, dsp, version, fee_lines JSON, effective_from
- `margin_ledger` — id, workspace_id, period, dsp_adapter_id, client_billed_cents, platform_fees_cents, passthrough_cents, marketr_margin_cents (distinct lines, never commingled)

**F6 — Launch:**
- `launch_checklist` — id, item, category (security|legal|community|build), status, evidence_url, completed_at

---

## 5. API routes

Base: `app/api/flywheel/*` (following the Phase 6 `/api/authority/*` convention).

**F1 — Reallocation:**
- `POST /api/flywheel/reallocation/proposals` (optimizer output) · `GET /api/flywheel/reallocation/proposals/:id` (decision record) · `POST /api/flywheel/reallocation/proposals/:id/approve` (mode a — materializes Phase 5 approval object)
- `POST /api/flywheel/reallocation/sras` (create envelope — explicit opt-in, conservative defaults) · `GET /api/flywheel/reallocation/sras/:id` · `POST /api/flywheel/reallocation/sras/:id/revoke` (instant)
- `POST /api/flywheel/reallocation/runs` (trigger optimizer run) · `GET /api/flywheel/reallocation/runs/:id` (proposals, policy decisions, executions)
- `GET /api/flywheel/reallocation/curves` (per-channel curves, R², calibration factors)
- `GET /api/flywheel/reallocation/breakers` · `POST /api/flywheel/reallocation/breakers/:id/acknowledge`

**F2 — Recycling:**
- `POST /api/flywheel/recycling/briefs` · `GET /api/flywheel/recycling/briefs/:id` · `POST /api/flywheel/recycling/briefs/:id/approve` (routes variants into studio approval flows)

**F3 — Test Lab:**
- `POST /api/flywheel/tests` · `GET /api/flywheel/tests/:id` · `POST /api/flywheel/tests/:id/qa` (force-QA + A/A dry-run) · `POST /api/flywheel/tests/:id/launch` (QA-gated) · `POST /api/flywheel/tests/:id/pause`
- `GET /api/flywheel/tests/:id/results` (honesty-layer rendering: peek-safe boundaries, badges, verdict)
- `POST /api/flywheel/tests/:id/archive` (structured learning → Growth Memory sink)
- `GET /api/flywheel/tests/ideas` (PIE/ICE queue fueled by Phases 2–6)

**F4 — CTV:**
- `POST /api/flywheel/ctv/campaigns` (vibe adapter or concierge) · `GET /api/flywheel/ctv/campaigns/:id`
- `POST /api/flywheel/ctv/campaigns/:id/pause` (real pause via Vibe API; alert-only for concierge — UI copy enforced)
- `POST /api/flywheel/ctv/creative/validate` (ffprobe; blocks non-compliant)
- `POST /api/flywheel/ctv/spots` (per-spot QR/pURL minting) · `POST /api/flywheel/ctv/ios` (concierge IO generation)
- `GET /api/flywheel/ctv/attribution/:id` (layered/probabilistic: pixels, view-through, QR scans, search lift, geo-holdout)

**F5 — DSP:**
- `GET /api/flywheel/dsp/adapters` · `POST /api/flywheel/dsp/adapters/:id/connect` (BYO seat; fails closed without one)
- `GET /api/flywheel/dsp/tripwire` (aggregate spend → rail recommendation with fee math)
- `GET /api/flywheel/dsp/fee-schedules` · `POST /api/flywheel/dsp/fee-schedules` (versioned)
- `GET /api/flywheel/dsp/margin-ledger` (distinct lines; never commingled)

**F6 — Launch:**
- `GET /api/flywheel/launch/checklist` · `POST /api/flywheel/launch/checklist/:id/complete` (with evidence)

---

## 6. UI routes

- `/dashboard/flywheel` — command center: reallocation mode + SRA status, active experiments, CTV pipeline, recycling queue, DSP tripwire band, launch-readiness progress
- `/dashboard/flywheel/reallocation` — mode toggle (a: propose-only default / b: SRA opt-in), SRA envelope config with plain-language consequences, proposal queue with marginal-ROAS decision records, breaker status + acknowledgment, immutable audit log view
- `/dashboard/flywheel/recycling` — recycling briefs with creative-hash lineage, variant approval routing
- `/dashboard/flywheel/tests` — Test Lab: idea queue (PIE/ICE), experiment builder, QA/preview, honesty dashboard (badges, verdicts, INCONCLUSIVE states), archive view
- `/dashboard/flywheel/ctv` — campaign list (API vs concierge labeled), creative validator, per-spot QR/pURL kit, IO workflow states, attribution views (probabilistic labels)
- `/dashboard/flywheel/dsp` — adapter list with seat status, tripwire report, fee-schedule versions, margin ledger (distinct lines)
- `/dashboard/flywheel/launch` — readiness checklist by category with evidence links; decision brief for the deferred open-core split
- Settings → Flywheel: SRA defaults, GrowthBook/stats config, Vibe linkage, DSP seat configs, reallocation run cadence

---

## 7. MVP scope

**In:**
- F1: marginal-ROAS optimizer (Hill/power/log-log curves, adstock, seasonality), lag handling (maturity delays, multi-window agreement, measurement-health freeze), anti-churn (≤20%/step, 72h cool-downs, stabilization windows, min meaningful shifts), per-channel learning-viable floors, 70-20-10 exploration slice, brand segmentation; mode (a) propose-only with per-move Phase 5 approval objects; mode (b) behind the signed SRA (allowlist, ≤$1k/shift, two-person ≥$1k cumulative, ~15%/~25% daily/weekly caps, ±10% band default, ≤30d expiry, instant revocation) — explicit opt-in, defaults disabled; deterministic Policy Engine; executor re-verification at checkout; five one-way-ratchet breakers with human acknowledgment; immutable replayable audit log; reallocation between platform campaigns only (never inside PMax/Advantage+)
- F2: trigger signals from Phases 2–6, recycling brief object with creative-hash lineage, deterministic channel-pair adaptation rules, supervised headline/CTA rewrite, routing of all regenerated assets through existing approval flows
- F3: vendored GrowthBook OSS stats core (Bayesian default, sequential inference, SRM χ² α=0.001 hard gate, frequentist backstop), integrity battery before results render, experiment object lifecycle (draft→qa→running→complete→archived), PIE/ICE ideation fueled by Phases 2–6, force-QA + A/A dry-run, honesty dashboard (peek-safe, power badges, profit guardrails, auto-INCONCLUSIVE), web SDK / email native / ads platform-native-import / mail split drops, traffic-floor refusal with MDE math, Growth Memory archive sink (forward-compatible schema); visual editor explicitly out
- F4: ffprobe creative validator (IAB Dec 2025 draft specs, blocks non-compliant), per-spot dynamic QR/pURL kit (≤3-tap landings), concierge IO workflow for MNTN/Roku/Tatari/tvScientific (draft→human-placed→live→reconciling, "alerts only" copy), Vibe API adapter (version-pinned, test-mode default, CRUD + pause + reporting only — budget moves via F1), layered probabilistic attribution (pixels, view-through, QR scans, search lift, geo-holdout planner), BYO-seat adapters (TTD/DV360/Amazon/Basis) failing closed
- F5: seat-agnostic campaign/line-item model with DSP plug-in adapters, margin accounting ledger (distinct lines), versioned fee-schedule registry, approval-object ↔ DSP cap mapping, kill-switch ↔ pause-API mapping (real calls where seats exist), tripwire decision tree with fee math; DSP contracts/billing with agency/client only
- F6: full-history secret scan + rotation/scrub, .gitignore/workflow audit, PII + demo-data audit, AGPLv3 LICENSE + copyright holder + package.json alignment, THIRD_PARTY/SBOM license audit, CONTRIBUTING (with CLA-or-DCO statement + open/commercial boundary), SECURITY.md, CODE_OF_CONDUCT.md, templates, .env.example, CHANGELOG discipline, CI green on clean clone, credential-free E2E smoke, <10-min self-host quickstart, README/docs bar, staged Product Hunt playbook, open-core options map as decision brief (no decision)

**Out (non-goals):**
- Autonomous spend of any kind — the exit gate (mode (b) is bounded pre-signed authority, not autonomy)
- Reallocation inside PMax/Advantage+ black boxes (between-campaign only in v1)
- Perpetual or auto-renewing SRAs (≤30d, explicit re-sign)
- Visual A/B editor (v2, deliberately)
- GrowthBook enterprise components (visual editor, CUPED packaging, SSO) — license-forbidden, permanently
- One-click buying across Roku/Samsung/LG inventory (not feasible — no buyer APIs)
- Deterministic CTV ROAS (probabilistic presentation only, permanently)
- Programmatic guardrails inside vendor UIs on the concierge path (alert-only, honestly labeled)
- DSP seats in v1 (readiness only; seats are agency commitments)
- Any public repo flip in v1 (readiness only; the split decision is deferred)
- CUPED (v2 native; GrowthBook's packaged version is enterprise-locked)

---

## 8. Monetization (per master plan §4)

- **Hosted:** reallocation as an agency-tier feature (mode (b) bounded guardrails as the upsell — "bounded autopilot" sells, but only inside the human-signed envelope); Test Lab per-experiment or tier-priced (analyses are cheap — the value is the honesty layer); CTV as planning-fee + passthrough (Vibe spend billed client-side; Marketr never touches the money); DSP readiness bundled in the agency tier (margin ledger proves the agency's take is clean); creative recycling bundled (compounding value, not a line item).
- **Self-hosted:** bring your own Vibe creds, DSP seats, GrowthBook-compatible data, LLM keys; Marketr charges nothing on spend volume or test count.
- **Metering:** new meters for optimizer runs, test analyses, CTV spend passthrough — passthrough costs tracked separately from Marketr margin, never mixed (MASTER-PLAN §3.3). The margin ledger's distinct lines are the product: client-billed vs. platform-fees vs. passthrough vs. Marketr-margin.
- The flywheel is the compounding story: every phase's data feeds the next phase's decisions — attribution (C2) → reallocation (F1) → recycling (F2) → tests (F3) → Growth Memory (Phase 8).

---

## 9. Safety invariants

These are structural, not configurable. A build that violates any of them fails the phase.

1. **Every dollar stays human-signed.** Mode (a): per-move human approval materialized as Phase 5 approval objects. Mode (b): moves execute only inside a human-signed, expiring SRA. There is no third path.
2. **The SRA is a pool-cap object, not standing authority.** Mandatory ≤30d expiry with explicit re-sign; explicit per-workspace opt-in; defaults to disabled; instant revocation effective even mid-flight via checkout-time re-verification. "Standing" means pre-signed for a window, not perpetual.
3. **Three-plane separation is load-bearing.** The optimizer proposes (it cannot touch money); the deterministic Policy Engine authorizes (it is LLM-proof — the LLM cannot widen its own envelope); the Phase 5 Executor re-verifies at checkout (signature, cumulative caps, revocation — at execution time, not proposal time).
4. **The two-person rule follows the money.** ≥$1,000 per shift needs two signers — and cumulative daily movement ≥$1,000 needs two signers too, so ten $150 shifts can't dodge the gate.
5. **Timeout means no.** An expired, revoked, or uncheckable SRA = deny. Silence = halt. The executor's dead-man default is rejection.
6. **Breakers are one-way ratchets.** They can pause or freeze; they can never authorize spend. A fired breaker requires human acknowledgment plus a mandatory cool-down before the optimizer may touch the channel again.
7. **Never reallocate on broken measurement.** The measurement-health pre-check freezes mode (b) on degraded data — an outage masquerading as underperformance must not trigger shifts. Attribution-regime changes freeze for one full stabilization window.
8. **v1 stays outside the black boxes.** Reallocation moves budget *between* platform campaigns only — never inside PMax/Advantage+. Brand-capture spend is segmented out of marginal-ROAS math before any proposal exists.
9. **No recycled creative buys without its own approval.** Every regenerated asset re-enters studio approval and per-buy creative-hash binding. Recycling proposes; humans approve.
10. **The Test Lab never declares a winner it can't defend.** SRM failure = results refuse to render. Underpowered tests = INCONCLUSIVE with the detectable-lift math stated. Conversion tests without profit guardrails don't launch. Bayesian early-reads are gated on expected loss + minimum data.
11. **CTV attribution is probabilistic, always.** Impression-to-conversion is device-graph inference or geo-holdout experiment — never ledger-grade. QR/pURL scans are the deterministic slice and are labeled as such. Deterministic CTV ROAS is never presented.
12. **Concierge paths are alert-only, labeled in the UI.** Where no API exists, Marketr monitors and alerts the human to pause — it never implies it can pause for them.
13. **Zero-custody extends to seats and spend.** DSP contracts and billing sit with the agency/client entity. Marketr orchestrates, approves, kill-switches, and accounts — it never holds, fronts, or co-mingles funds, and the margin ledger keeps the four money lines distinct.
14. **GrowthBook license hygiene is permanent.** MIT core only. Nothing under `packages/enterprise` enters the tree — no visual editor code, no packaged CUPED, no SSO. Verify the OSS/enterprise boundary at build time; it has moved before.
15. **§3.1 red-lane rules apply.** Money and reputation actions never reach autopilot; the SRA is the maximum automation allowed near money and it is a human-signed, bounded, expiring envelope. Everything is workspace-isolated and audit-logged.

---

## 10. Success metrics / exit gates

1. **Reallocation battery green 3×:** marginal-ROAS curves fit on fixtures with sane R²; optimizer proposes shifts only when multi-window agreement holds; lag-window enforcement (no proposal on fresh partials); measurement-health freeze triggers on degraded fixtures; learning-viable floors refuse micro-allocation; exploration slice untouched by optimizer; brand spend segmented out.
2. **SRA adversarial battery green 3×:** shift above per-shift cap denied; cumulative ≥$1k without two signers denied; out-of-allowlist channel denied; expired SRA denied; revoked SRA denied mid-flight (checkout re-verification); band violation denied; cool-down violation denied; every denial logged with reasons.
3. **Mode-(a) E2E:** attribution snapshot → proposal → human approval → Phase 5 approval object → executor re-verification → executed move, with the full decision record (data window, curve params, model version) attached.
4. **Breaker battery green 3×:** simulated CPA blowout / spend-velocity spike / measurement outage / attribution-regime change each freeze the right scope; human acknowledgment + cool-down required to resume; breakers provably cannot authorize spend (attempt to invert = denied).
5. **Test Lab stats battery green 3×:** injected SRM failure → results refuse to render; underpowered fixture → INCONCLUSIVE with detectable-lift math; profit-guardrail violation → conversion test refuses to launch; peeking simulation → no false "winner" on fixed-horizon design; Bayesian early-read gated on expected loss.
6. **Test Lab E2E:** idea → traffic-floor check → QA/A/A dry-run → launch → monitoring → verdict → structured learning archived to the Growth Memory sink schema.
7. **CTV battery green 3×:** ffprobe validator blocks non-compliant creative (wrong resolution/codec/loudness); per-spot QR/pURL mint correctly and scan back to the spot; Vibe adapter without creds → honest not-configured; Vibe test-mode never touches real spend; concierge pause attempt → alert-only (no fake pause); budget-move attempt through the Vibe adapter → routed to F1.
8. **DSP readiness battery:** tripwire decision matches the fee math at each band; margin ledger lines provably distinct (no commingling on fixtures); fee-schedule versioning pins the live schedule to the spend period; seat-less adapter → fail closed with setup guidance.
9. **Launch-readiness checklist:** full-history secret scan clean (any hit → rotate + scrub before anything else); community files present; CI green on clean clone; credential-free E2E smoke passes; quickstart reaches a running instance <10 min. **No public flip is part of this phase.**
10. Standing bar: TypeScript clean, production build green, M11 security battery green, module batteries green ×3, secret scan clean, independent verification before commit.

---

## 11. Honest limitations

- **The Vibe API is weeks old.** Docs and endpoints must be verified at build time; version-pin aggressively; treat the adapter as beta until the API proves stable.
- **CTV attribution is directional.** Device-graph matching is probabilistic; geo holdouts are experimental. The QR/pURL slice is deterministic and labeled as such; everything else is layered inference.
- **Concierge buying has no programmatic guardrails.** Kill switches, pacing enforcement, and executor re-verification cannot reach inside a vendor UI. Marketr alerts; the human pauses. The product must say this plainly or it will be blamed for a UI it can't touch.
- **PMax/Advantage+ stay black boxes in v1.** The optimizer works around them (between-campaign moves), not inside them. The 70–80% of marketers still on last-click won't get full-funnel truth from platform data alone.
- **SMB stats are a physics problem, not a UX problem.** Low-traffic sites can only detect large effects; the lab's job is to say so honestly and redirect to qualitative methods or big swings — not to manufacture significance.
- **DSP seats are agency commitments, not features.** Spend floors, contracts, and onboarding are real; the adapter must never promise "one-click TTD" to a customer without a seat.
- **The open-core split is genuinely undecided.** F6 builds readiness and the decision brief; anyone expecting a launch date from this phase is reading the wrong spec.
- **Growth Memory is Phase 8.** F3 archives against a forward-compatible sink schema; the store itself doesn't exist yet.

---

## 12. Open questions

1. **[APPROVED 2026-09-25] SRA default calibration:** confirm ±10% per-channel band, ~15% daily / ~25% weekly aggregate caps, $1,000 cumulative two-person threshold — or adjust?** Recommendation: **confirm as defaults, adjustable per workspace.** The numbers are empirically grounded (Meta's ≤20%/step scaling ladder; the $1k two-person rule matches Phase 5), and per-workspace adjustability lets aggressive accounts widen the envelope deliberately while conservative ones stay at defaults.
2. **[APPROVED 2026-09-25] Incrementality source: built-in geo-holdout v1.** built-in geo-holdout only, or ingest client lift studies as calibration?** Recommendation: **built-in geo-holdout planner in v1; lift-study ingestion (Northbeam/Haus-style) as labeled calibration in v2.** The built-in planner keeps the loop self-contained and honest; ingested studies arrive with their own methodologies and need a calibration-factor framework before they can touch the curves.
3. **[APPROVED 2026-09-25] GrowthBook embedding: vendored package.** vendored package vs. sidecar service?** Recommendation: **vendored package.** Zero ops burden, matches Marketr's self-hosted story (the stats worker runs in-process, not as a second deployable), and the OSS boundary is easier to audit in the tree. Sidecar only if the Python gbstats proves un-portable at build time — decide then, with evidence.
4. **[APPROVED 2026-09-25] Vibe adapter depth: CRUD + pause + reporting only.** campaign CRUD + pause + reporting only, or budget moves too?** Recommendation: **CRUD + pause + reporting only in v1.** Budget moves are money movement and belong in F1's reallocation machinery (optimizer → Policy Engine → executor), where the SRA envelope and breakers govern them — not in a channel adapter where they'd bypass the three-plane architecture.
5. **[APPROVED 2026-09-25] Public-launch scope: readiness only, no flip.** repo-hygiene + staged playbook only, or actually flip the repo public within the phase?** Recommendation: **readiness only — no public flip in v1.** The open-core split itself is deferred by standing decision, and flipping a repo public before the split is decided would force the licensing call under deadline pressure. The hygiene work is the same either way; the flip waits for the split decision.
