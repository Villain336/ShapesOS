# Marketr — The Complete Vision

> Definitive breakdown of everything Marketr will be when it's done. Compiled 2026-10-01 from the core spec, master plan, all phase specs, the Business OS specs index, and verified git history.
> Status legend: ✅ shipped · 🟡 in-flight (being built now) · 📝 specced (approved spec, no code) · 💡 planned (direction set, no spec yet)
> One line per item: name — what it does — status. Vault-private.

**The sentence:** Marketr is the open-source marketing & SEO workspace that grew into a Marketing + Design + Business Ops agentic OS — "launch, operate, and grow your business." Three pillars (Grow / Design / Operate), one agentic layer, one platform.

---

## Pillar 1 — Grow (Marketing)

### SEO core (Phases 0–2) ✅
- Keyword research — seed → clustered ideas with volume, difficulty, intent via DataForSEO Labs — ✅ shipped
- Competitor gap analysis — keywords they rank for that you don't, one-click to content engine — ✅ shipped
- Rank tracking — daily/weekly checks, visibility score, AI Overview presence flag, movement alerts — ✅ shipped
- Site audits + fix agent — first-party crawler, prioritized issues; agent fixes safe-tier items (meta, titles, alt text, schema) on a trust ladder: approve-each → scheduled → autopilot, with snapshot + one-click rollback — ✅ shipped
- Content engine — SERP-informed brief → outline approval → AI draft → editor with live SEO score → Markdown/WordPress publish — ✅ shipped
- Content decay & refresh engine — watches published content for ranking decay, one-click refresh briefs — ✅ shipped
- AI-search visibility — weekly brand-mention checks across ChatGPT, Perplexity, Gemini, Google AI Overviews; competitor-citation alerts — ✅ shipped
- Internal linking engine + programmatic SEO builder — site-wide link suggestions; templates × keyword datasets → hundreds of pages — ✅ shipped

### Lead & revenue (Phases 1–2) ✅
- Lead Pipeline CRM — the canonical `Lead` object: pipeline Kanban, capture forms, dedupe, scoring rules, activity timeline — ✅ shipped
- Revenue attribution dashboard — first/last/multi-touch attribution, UTM + call-source tracking, per-channel CPL/CAC/ROAS — ✅ shipped

### Engagement loop (Phase 3) ✅
- Nurture — email/SMS lifecycle engine: drip builder, speed-to-lead, missed-call text-back, TCPA/consent/quiet-hours enforced — ✅ shipped
- Review generation engine — post-transaction SMS/email requests, QR pages, AI-drafted responses → approval queue — ✅ shipped
- Prospecting (R6) — waterfall enrichment, AI research, converts into the canonical Lead — ✅ shipped

### Paid execution (Phases 4–5) ✅
- Direct mail automation — campaign builder → Lob/PostGrid: AI copy in approval queue, NCOA, tracking webhooks, triggered sends — ✅ shipped
- Call tracking & booking — numbers, DNI, recording/transcription summaries, booking pages — ✅ shipped
- Media buying v1 — generalized ladder + media planning; **zero custody of client spend locked** (Marketr never holds/touches/transmits client money; planning fees + % of spend only) — ✅ shipped

### Authority & AI relevance (Phase 6) ✅
- Guest-post outreach engine — prospecting, pitch sequences, placement tracking — ✅ shipped
- Digital PR — newsworthy-angle drafting, journalist lists, pitch tracking — ✅ shipped
- Answer-engine optimization agent — citation-gap fixes, entity/schema reinforcement for AI answers — ✅ shipped
- Maps & review-site agent + local listings/citations — ✅ shipped
- Onboarding Intelligence Report — connect the client's stack → full audit pack → 90-day Growth Plan (the wedge demo) — ✅ shipped

### Flywheel (Phase 7) ✅
- Cross-channel budget orchestration agent — proposes reallocations, human approves (autopilot never moves money) — ✅ shipped
- Creative recycling pipeline — winning mailer → billboard variant, etc. — ✅ shipped
- Performance pricing path — 10–15% revenue share or pay-per-lead once attribution is airtight — ✅ shipped

### Video & voice content (Phases 13C–13D) ✅
- Clipper — long video in, viral shorts out: transcribe → hook/virality scoring → 15–60s segments → 9:16 auto-reframe → brand-kit captions → **draft-for-approval, never auto-post** — ✅ shipped (2026-09-28)
- Voice/text agents (LiveKit) — lead follow-up calls + SMS (opted-in prospects only, AI disclosure, kill-switch, full transcripts) and AI voiceovers for clips; **VoiceStudio is the default TTS** (local-first, no per-minute cost) — ✅ shipped (2026-09-28)
  - *Conflict note: the 13D phase spec file still says "building"; git shows the build committed 2026-09-28 and it's treated as complete.*

### Ad platforms (Phase 18) ✅
- Unified ads ontology — one campaign object, one proposal inbox, one reporting surface (`AdReport`) across all platforms — ✅ shipped
- Spend gate — every launch/budget change creates a `SpendProposal` → immutable `SpendApproval` → execute; autopilot never buys media — ✅ shipped
- Amazon Ads connector — API v3: read, propose → approve → launch, pause, budget adjust, async reporting — ✅ shipped
- StackAdapt connector — native/display/video/CTV/audio/DOOH + ChatGPT inventory, spend executor, delivery reporting — ✅ shipped
- Walmart Connect — guided-only (partner API is WCPN-exclusive; no public OAuth exists): placement planner, manual ID linking, CSV spend import — ✅ shipped
- Spotify — guided-only (no public campaign API): setup wizard, budget planner, UTM/pixel templates, spend import — ✅ shipped
- ChatGPT Ads — conversational-intent ad ontology, propose flow, approval sync, launch checklist, CPA variance alerts, Conversions API — ✅ shipped (wave-2 quick win, 2026-10-01)

### Social & messaging ✅ / 🟡
- Social — single Postiz-centered entry; all publishing/scheduling routes through Postiz — ✅ shipped (Wave B slice 1)
- Messaging inbox — one big unified inbox: one thread per lead, nurture + voice/SMS/chat timelines merged, consent chips; inbox never sends directly (routes through gated flows) — 🟡 in-flight (Wave B slice 4)
- Prospect model unification — `Lead` canonical; Prospect/OutreachProspect resolve to it — 🟡 in-flight (Wave B slice 2)
- Analytics home — `Analytics` becomes the one home; Reports folds in as saved views — 🟡 in-flight (Wave B slice 3)

---

## Pillar 2 — Design

- Creative Studio — the house-style reference implementation; primary code/style reference for all UI — ✅ shipped
- Canvas editor (Phase 11) — native Konva editor (Polotno-class, learned-from/never-copied): AI design generation (draft-first, schema-validated), client-side background removal, server render API (DesignDocument JSON → PNG), share/comment/approval links — ✅ shipped
- Editor features (Phase 11b) — rich text + text-on-path, magic resize, charts + QR codes, SVG export, `{{variable}}` batch fill, collaboration, Unsplash — ✅ shipped
- Editor integrations (Phase 11c) — full ranked top-10 list run: Brandfetch, Iconify, server render API, and more — ✅ shipped
- Knowledge Brain — the corpus command center (339 sources, 5,924 chunks): Obsidian-graph-style luminous galaxy on light space, 48 source cores + chunk sparkles, audit layer (health strip, source register, activity feed, dossiers) — ✅ shipped
- Brain dark v2 — full dark particle-universe reskin: bloom-on-load cinematic, node → document transitions, 3-pane layout; spec approved, build explicitly cancelled by Tico ("Don't build") — 📝 specced + parked
- Branded report engine (Phase 16) — BrandKit model + versioned HTML+CSS templates + WeasyPrint PDF renderer; every figure source-traced, never invented numbers; report send is draft-for-approval — ✅ shipped
- Agentic OS design system — Archivo, #F3F3F1 canvas, black sidebar, status color+shape language, black primary actions; replaces the earlier dynamic brand-color theming (deferred by Tico) — 🟡 in-flight (14 migration slices committed 2026-10-01, visual-only, whole app)

---

## Pillar 3 — Operate (Business Ops)

### Commerce & operations core (Phase 17) ✅
- DocType-style entity convention — every ops entity is schema + auto REST API + permissions by construction — ✅ shipped
- Invoicing — draft → approve → send → paid/overdue; sending is a gated write (money red lane); overdue reminders agent-drafted, gate-approved — ✅ shipped
- Inventory — stock levels, low-stock alerts, purchase orders — ✅ shipped
- Projects — milestones, time ledger, linked to CRM leads; HR essentials (team directory, leave requests) — ✅ shipped
- Commerce — product catalog → cart/order → Stripe payments → promotions (Medusa v2 packages adopted, Marketr UI shell); funds never touch Marketr — ✅ shipped
- OpsWorkflowRun — saga-style compensation/rollback for multi-step agent operations — ✅ shipped

### Wave-2 quick wins (built 2026-10-01) ✅
- E-sign — envelope ontology, Documenso vendor adapter, hash-chained audit, native OS signing UI, templates, legal binding + evidence vault, agent-driven signing workflows — ✅ shipped
- Insurance — policy inventory ontology + dashboard, quoting agent + CoverForce adapter, licensed-partner bind gate, governed-action approval + audit, bind execution + zero-custody handoff, renewal remarketing, COI pipeline (ACORD 25) — ✅ shipped
- WFH mode — WorkMode object + toggle, async-first notifications, focus blocks, async standups, team rituals engine, home-office expense pack, day view + 13B learning-loop signals — ✅ shipped
- context.dev integration — connector core (budgets, vault keys), KnowledgeSource + crawl jobs, research agent tool, change-monitor engine, approval-gated brand sync — ✅ shipped

### Launch-pillar on-ramp 🟡
- Dataset Builder — "transfer your business into the AI world": ingest (uploads, Drive, web crawl) → auto-classify into FAQs/products/policies/SOPs → compile versioned datasets with lineage → one-click publish into the tenant's BriefNow connector and OS RAG layer — 🟡 in-flight (slices 1–2 committed 2026-10-01)

### Specced, awaiting build 📝
- Legal/Compliance — per-tenant obligation map (industry × business model × jurisdiction), deadline engine feeding the OS Feed, document vault, regulation change radar — 📝 specced
- Funding/VC — investor CRM (target → term sheet), data room with expiring links + per-viewer analytics, round-readiness checklist; Boardy AI preloaded as starter contact (not the front door) — 📝 specced
- CAD + Hardware — in-browser CAD viewer + versioning, AI design assistant with manufacturability flags, one-click prototype export (3D print/PCB/CNC), auto-BOM + cost estimates — 📝 specced
- Finance module — corrected spec approval still needed — 💡 planned
- Compliance / Trust / License — license-guard rails (AGPL/GPL/Fair-Source handling), trust scoring — 📝 specced
- Payroll — via Check (licensed money-transmitter, 50 states); Marketr never becomes employer of record — 📝 specced
- Field service management — native dispatch (Jobber/Housecall Pro as migration adapters); HVAC + plumbing + electrical v1 — 📝 specced
- Booking / appointments — native build (Cal.com went closed-source; Calendly can't create server-side); Booking = Visit on the dispatch board — 📝 specced
- Multi-entity + multi-currency — consolidation logic is ours (the moat); FX bought (Frankfurter/ECB); intercompany out-of-balance blocks close — 📝 specced
- Inventory depth — native ledger owns value (Medusa = availability cache); FIFO + moving average, append-only layers — 📝 specced
- Procurement depth — 3-way match failures never auto-post; confidence-gated draft-PO agent — 📝 specced
- Subscriptions / recurring billing — Stripe Billing underneath; plan versioning, founder-voice dunning, pause/cancel/win-back; autopilot never bills — 📝 specced
- Manufacturing (MRP-lite) — 📝 specced · Permits + Construction — 📝 specced · School staff & administration — 📝 specced
- Expansion + Franchising — 📝 specced · Acquisition — 📝 specced · IP / Trademark / Copyright — 📝 specced
- Multilingual agent knowledge — 📝 specced · C-level suite — 📝 specced · Contractors & Hiring — 📝 specced

---

## The Agentic Layer

- Fix-agent trust ladder — the pattern every agentic module copies: supervised → scheduled → autopilot, with module-declared rungs, escalation triggers, rollback stories; **media buying and money movement never reach autopilot** — ✅ shipped
- GrowthOS orchestrator (Phase 9) — Chief Strategy Agent decomposes a revenue goal into a coordinated multi-agent plan; command-bar UX; Growth Missions (Enter a New City, Launch a Product…); versioned Agent Playbooks library — ✅ shipped
- Agentic substrate (Phase 8) — per-client Business Graph, Campaign as a first-class cross-channel object, Growth Memory (every experiment + outcome recorded, queryable by every agent) — ✅ shipped
- Expert brain (Phase 10) — expert constitution governing agent behavior + the SFT trace-data factory (2,730-trace pilot proved the "train like the labs" path) — ✅ shipped
- Composio action layer (Phase 14) — 100+ app integrations behind one API (Gmail, Slack, Sheets, HubSpot, Notion); our own approval gate: reads auto (logged), writes need approval, destructive needs approval + confirmation; never silent auto-execution — ✅ shipped
- Composio full catalog (Phase 15) — live toolkit discovery, pattern-based risk-tier derivation, unclassified tools land gated, per-workspace call budgets + 80% alerts — ✅ shipped
- Agent experience (Phase 16) — CopilotKit deep integration (generative UI, shared agent↔UI state, in-flow HITL approvals); Playwright viewable runs (video + DOM-snapshot replay + live "watch" mode); mobile app (Expo iPhone/Android: agent chat + native approval HITL) — ✅ shipped
- Agent learning + company intelligence (Phase 13B) — episodic memory per workspace, edit-diff feedback signals, nightly "sleep" consolidation into durable lessons, "what I've learned about you" surface; Jasper-style-but-alive Brand Voice engine, company knowledge graph, fail-closed style rules — 📝 specced (queued after Wave A)
- Connector agent — every tenant's personal Boardy-style superconnector: LEADS mode (customer/partner intros) + FUNDING mode (investor intros via the Funding/VC CRM); strict double-opt-in intro lifecycle; contact graphs vault-held, tenant-isolated, never cross-enriched; ships WITH Funding/VC — 📝 specced
- OS Cursor — voice-first second-cursor assistant (OS-integrated = primary product, desktop-native = demo): points at real elements, acts only through governed actions (propose → approve → execute, full lineage); agent mode spawns background agents with user-set spend caps — 📝 specced
- Simulated World (Pre Launch Panel v2) — real visual 3D simulated town (Three.js): generative agents with daily routines, time controls, founder interventions (drop a product, change pricing, run an ad); calibration honesty is structural (confidence labels, never claims representativeness) — 📝 specced (v1 text-persona simulator built separately at ~/workspace/dress-rehearsal/, 138/138 tests)
- Digital Business Twin — NVIDIA-style visual 3D twin of the actual business (store/warehouse/factory), live-bound to OS data (ledger, inventory, ops); Three.js v1, USD export as the Omniverse upgrade path; warehouse recommended as v1 template — 📝 specced
- Twin-in-Sim — the convergence: the live-bound twin becomes a building *inside* the simulated town; town agents become foot traffic; behavior feeds back as demand signal — 📝 specced (exploration doc)

---

## Platform & Infrastructure

- Metering ledger — append-only, idempotent, per workspace/project/key; every module ships with a meter — ✅ shipped
- Billing — Stripe: metered billing on tracked keywords / AI words / client seats / leads / messages / call minutes; top-ups, overage invoicing ($0.012/credit, $5 minimum), spend caps with pre-execution blocking — ✅ shipped
- Tiers — Self-hosted free (BYO keys) · Starter $29/mo · Pro $79/mo · Agency White-label $199/mo — ✅ shipped
- White-label — client workspaces, custom domain/logo, client viewer logins, scheduled branded PDF reports — ✅ shipped
- License — AGPLv3 core + commercial white-label module (n8n playbook); money-moving modules flagged commercial-only (decision open with Tico) — ✅ decided
- MCP server + API — 10+ tools, scoped expiring revocable API keys, OAuth 2.1 + PKCE; agents run SEO workflows through Marketr — ✅ shipped
- Mobile — Expo iPhone/Android app on the same AG-UI backend (agent chat, native approval HITL) — ✅ shipped
- Voice substrate — VoiceStudio (local, :3900) is the default TTS everywhere; LiveKit for conversational agents — ✅ shipped
- Zero-custody doctrine — client ad spend, media funds, payroll funds, commerce payments: Marketr plans/proposes/records, never holds or moves money — ✅ architectural law
- Model-training direction — Marketr trained like the big labs: RAG corpus → expert reasoning-trace SFT dataset → fine-tune 8B-class open model; clean data only — 💡 direction set, no build
- OS Feed — Bloomberg-terminal × Muse-feed home screen (daily habit/retention loop) — 💡 pre-spec
- Self-host — one-command Docker Compose, BYO DataForSEO + LLM keys — ✅ shipped

---

## Build Queue (ordered, per Tico's latest decisions)

1. **Agentic OS design-system migration** — 🟡 in-flight (visual-only, whole app; 12 slices committed 2026-10-01)
2. **Dataset Builder** — 🟡 in-flight (slices 1–2 done; 3–4 to go)
3. **Wave B completion** — slices 2–4 (prospect unification, analytics home, messaging inbox)
4. **Legal/Compliance** → **Funding/VC (+ Connector agent)** → **CAD + Hardware** — approved sequence, specs written
5. **Spec-complete wave** (build order Tico's call): Finance module · wave-2 modules (digital twin, multilingual, compliance, expansion, acquisition, IP, manufacturing, permits, school, C-level, contractors) · gap modules G1–G8 (payroll, field service, booking, multi-entity, inventory depth, procurement depth, subscriptions)
6. **Phase 13B** — agent learning + company intelligence
7. **OS Cursor** → **Simulated World v2** → **Twin-in-Sim** — build last, in that order

---

## Status conflicts (sources disagree — flagged, not guessed)

- **Phase 13D:** the phase spec file says "APPROVED — building"; git shows the build committed 2026-09-28 and it's treated as complete. Marked ✅; the spec file's status line is stale.
- **Wave B:** slice 1 committed 2026-09-28; slices 2–4 have no build commits in git. Marked partial/in-flight.
- **Dynamic brand-color theming:** locked 2026-09-27 ("every tenant's UI derives from their brand kit"), then superseded 2026-10-01 by the Agentic OS design system (Tico deferred the brand-color decision — "use only the new design system for now"). The migration is what's actually being built.
- **Phase 18 ordering:** the 18 spec lists "queue position" as an open decision; in practice it was approved and fully built 2026-09-30 → 2026-10-01.
