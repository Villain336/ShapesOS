# Business OS Feature Specs — Dataset Builder, CAD+Hardware, Funding/VC, Legal/Compliance

**Date:** 2026-09-28
**Status:** DRAFT for Tico's approval. Pre-build — no implementation authorized.
**Parent doc:** `BUSINESS-OS-BRAINSTORM.md`

## 0. Shared decisions (locked)

- **Nango: managed Cloud, NOT self-hosted** (Tico 2026-09-28). The later BriefNow build-out uses Nango Cloud as the integration runtime: managed OAuth, token refresh, request proxying. On Cloud, auth + proxying are free without limits; Syncs / Webhooks / Actions / field mappings are the paid data layer (free tier to start). True per-tenant credential isolation holds on Cloud without the env-per-tenant gymnastics self-hosting would need.
- **ELv2 note:** as a Nango Cloud customer (not self-hosting or redistributing Nango), the licensing posture is cleaner — but the embedding model still gets a legal read before anything commits.
- **Open before the BriefNow build:** cost model at 10 / 100 / 1,000 connected tenants (Cloud pricing scales with connections).
- All four features below are OS-level, tenant-scoped, and follow the standing rules: consequential actions are draft-for-approval, every item grounded in a source or internal datum, clean-sourcing discipline on ingested content.
- Each feature ships in independently verifiable slices (Tico's pieces rule: code a slice → check → commit → next slice).

---

## 1. Dataset Builder — "transfer your business into the AI world"

**Problem.** A company's knowledge lives in docs, PDFs, FAQs, product catalogs, SOPs, policies, spreadsheets, and old emails — unstructured and unusable by agents. Before any business can have a working connector or agent, its knowledge must become clean, structured, AI-ready datasets. Today that transformation is manual, inconsistent, and legally murky.

**Job to be done.** "Take everything my business knows and make it something AI can actually use — without me becoming a data engineer."

**v1 scope (sliced):**
- **Slice 1 — Ingest.** Connect sources: file upload (PDF/DOCX/CSV/MD), Google Drive, website crawl, copy-paste. Every ingested chunk keeps a pointer to its source document (source register — the clean-sourcing discipline, no orphaned text).
- **Slice 2 — Structure.** Auto-classify into dataset types: FAQs, products/catalog, policies, processes/SOPs, company facts, pricing. Low-confidence classifications go to a human review queue (draft-for-approval pattern, same as the OS trust ladder).
- **Slice 3 — Build.** Compile versioned datasets (JSONL/Parquet) with lineage metadata: which source, which model, which transform, when. Dataset health panel: coverage, freshness, staleness alerts ("your pricing dataset is 90 days old").
- **Slice 4 — Activate.** One-click publish into the tenant's BriefNow connector (this fills the "real business-data adapters" gap in the BriefNow roadmap) and into the OS RAG/Feed layer so briefs and answers ground in it.

**Candidate engine.** NeMo Data Designer (Apache-2.0, runs on the current CPU box against hosted endpoints) for synthetic augmentation and distillable lineage; frontier APIs for small-batch extraction. The brief ranked it #1 for exactly this shape of work.

**Key entities.** Source, Document, Chunk (→ source pointer), Dataset, DatasetVersion, Classification, ReviewItem.

**Landscape.** Point solutions exist (knowledge-base builders, ETL tools, RAG ingestion pipelines), but nobody bundles **business-in → governed dataset → live connector** in one flow. That bundle is the wedge — the dataset builder is the on-ramp, the connector is the payoff.

**Open questions.**
- Which sources in v1: Drive + upload + web crawl, or narrower?
- Dataset versioning/rollback UX — how much history does a solo founder need?
- Pricing: per-seat, per-dataset, or bundled into the OS tiers?

**Success criteria.** A new tenant goes from "pile of docs" to a live, grounded connector in under a day. Zero ungrounded chunks (every chunk traces to a source).

---

## 2. CAD + Hardware

**Problem.** Founders building physical products — drones, devices, enclosures — have no CAD-to-prototype path inside their business OS. Design lives in separate tools, disconnected from the business: no versioning tied to the company, no BOM tied to costs, no prototype ordering tied to the project.

**Job to be done.** "Design the thing, check it'll actually manufacture, and order the prototype — without leaving my OS."

**v1 scope (sliced):**
- **Slice 1 — CAD viewer + versioning.** Upload and inspect 3D models (STEP/STL/OBJ) in-browser, version history, visual diffs between revisions, share links for collaborators.
- **Slice 2 — AI design assistant.** Natural-language annotations and edit requests on models ("thicken this wall to 3mm"), plus manufacturability flags: wall thickness, overhangs, tolerance risks.
- **Slice 3 — Prototype pipeline.** One-click export to prototype vendors (3D print / PCB / CNC), auto-generated BOM, cost estimates per revision.
- **Slice 4 — Hardware project management.** Parts inventory, supplier tracking, revision-linked tasks and issues.

**Reference customer.** The autonomous drone platform build — spec and slice the feature against it; if it serves the drone program, it serves hardware founders generally.

**Landscape.** Autodesk Fusion, Onshape, and PTC own professional CAD; the OS wedge is not beating them at CAD — it's the **business context around the CAD**: versions tied to projects, BOMs tied to costs, prototypes tied to vendors, all inside the operating system the company already runs on.

**Open questions.**
- Build the viewer on three.js (owned) vs embed Onshape/Autodesk (rented)?
- Real-time collaborative editing in v1, or async review first?
- Which prototype vendors / fab services in the v1 pipeline?

**Success criteria.** A founder goes from idea to ordered prototype without leaving the OS. Drone program runs its airframe revisions through it.

---

## 3. Funding/VC — Boardy as preloaded starter contact

**Problem.** Fundraising is a cold-start problem: founders don't know who to talk to, in what order, or what to send. Warm intros outperform cold outreach by an order of magnitude, but access to warm intros is unevenly distributed.

**Job to be done.** "Get me in front of the right investors, through people who'll actually take the meeting."

**v1 scope (sliced):**
- **Slice 1 — Starter network (Boardy preloaded).** Boardy AI ships as a **preloaded starter contact** in every tenant's funding graph — not the front door, just the first card in the deck. Boardy's job: help the user get *more* contacts, through warm intros matched to the founder's target investor profile. The feature's front door is the founder's own raise workflow; Boardy is the accelerant. (Tico 2026-09-28 correction: Boardy is not the gateway for all funding intent.)
- **Slice 2 — Investor CRM.** Pipeline stages (target → contacted → meeting → diligence → term sheet), contact enrichment, follow-up reminders, interaction history.
- **Slice 3 — Data room.** Versioned pitch deck, financials, metrics — shareable with expiring links and per-viewer analytics (who opened what, when).
- **Slice 4 — Round readiness.** Checklist: incorporation, cap table, SAFE templates (via the Legal feature §4), plus AI pitch-deck review against known investor patterns.

**Key entities.** Contact (Boardy preloaded as the starter contact), Investor, Interaction, IntroRequest, DataRoomDoc, Round.

**Landscape.** DocSend (data rooms), Foundersuite / Crunchbase (investor discovery), AngelList (round infra). The wedge is the **warm-intro layer**: everyone else sells tools for a process that starts cold; this feature starts with a live superconnector already in the graph, and the OS's own data (traction, round, deck) does the matching for every intro request.

**Guardrails.** Intro requests are rate-limited and context-rich — no spray-and-pray, ever. Boardy's reputation is the asset; the feature protects it.

**Open questions.**
- Boardy agentskill integration shape — confirm the interface with Boardy before speccing Slice 1 internals.
- Intro-request etiquette: who approves, what volume is acceptable?
- Round types in v1: pre-seed/seed only, or broader?

**Success criteria.** A founder's contact graph grows through Boardy intros within the first week of a round. Data-room views tracked end to end.

---

## 4. Legal/Compliance — "stay legal in your industry, with your business model"

**Problem.** Compliance is industry × business-model × jurisdiction specific — a food business, a drone business, and a SaaS company share almost no legal obligations. Founders discover obligations by getting fined, missing a filing, or operating without a required license.

**Job to be done.** "Tell me exactly what my business needs to stay legal, keep me ahead of every deadline, and warn me when the rules change."

**v1 scope (sliced):**
- **Slice 1 — Obligation map.** Onboarding captures industry + business model + jurisdictions → generates the obligation checklist: licenses, filings, tax registrations, insurance, permits. Nothing generic — the map is computed per tenant.
- **Slice 2 — Deadline engine.** Filings, renewals, annual reports, license expirations — with alerts that feed the OS Feed (the daily habit loop) and escalate as deadlines approach.
- **Slice 3 — Document vault.** Formation docs, contracts, licenses, EIN letters — versioned, with expiring-document alerts.
- **Slice 4 — Change radar.** Regulation changes in the tenant's industries and jurisdictions, in plain English, with "does this affect me" triage.

**Hullcheck synergy.** Hullcheck's "don't get sued" engine — legal, compliance, and security scanning for apps and websites — becomes the **digital-properties module** inside this feature. One legal surface: the physical/regulatory side from the obligation map, the digital side from Hullcheck.

**Guardrail (hard).** First-pass information, never legal advice. Every output labeled as such; attorney referral path for anything that qualifies as advice. This is the trust boundary the whole feature stands on.

**Landscape.** LegalZoom / Stripe Atlas (formation), Vanta / Drata (compliance automation, SOC2-centric), generic deadline trackers. The wedge: **per-industry, per-business-model, continuous** — not formation-only, not SOC2-only, and it watches the rules change instead of checking a box once.

**Open questions.**
- Coverage order: NC first, then national? Which industries first (food, drones, SaaS, services)?
- Regulation-tracking data source: build, buy, or partner?
- Attorney network in v1, or pure self-serve with referrals?

**Success criteria.** A tenant has zero surprise filings or deadlines in their first year. Obligation map covers their actual industry — not a generic template.

---

## 5. Branded Report Engine — "every number traced to a source"

**Problem.** Every feature in the OS produces data worth reporting — marketing performance, compliance status, dataset health, fundraising pipelines — but founders and agencies still assemble client, investor, and board reports by hand in slide decks. The work is repetitive, the numbers go stale between edits, and the branding is inconsistent.

**Job to be done.** "Give me a report I can send — my branding, my data, written up professionally — without building it myself."

**The Claude pattern.** Claude's Skills support brand-compliant document generation, and the ecosystem's working formula is: brand kit in, connected data in, polished branded PDF out, AI-written narrative — never inventing numbers for sources that aren't connected. ClientForge proved the commercial shape: auto-generated branded client reports with AI narrative for small agencies.

**v1 scope (sliced):**
- **Slice 1 — Brand kit + templates.** The tenant brand kit (logo, colors, fonts) plugs into the dynamic-theming lock — the same kit that themes the OS styles the reports. Versioned HTML+CSS report templates; deterministic rendering in code (the model composes content, the renderer produces the PDF). **Renderer: WeasyPrint** — proven 2026-09-29: pip-installs clean on the CPU box, renders a 2-page A4 Bit.ai-style report in ~2s, no new infra (proof: `workspace/biz-os/report-engine-proof/competitor-report-proof.pdf`). Template-authoring rule from the proof: no CSS Images L4 double-position color stops — WeasyPrint silently drops the entire background; lint templates for this. Template #1: open — Tico rejected the Pre Launch Panel official-report standard as the starting template (2026-09-29).
- **Slice 2 — Data bindings.** Reports bind to live OS data sources: Grow metrics, compliance deadlines/status, dataset health, fundraising pipeline, data-room views. Every figure carries a source pointer — no orphaned numbers, ever.
- **Slice 3 — AI narrative.** AI-written executive summary and section narratives over the bound data, in the tenant's brand voice (13B intelligence layer when available). Draft-for-approval before anything sends — the author reviews, edits, regenerates.
- **Slice 4 — Distribution.** Scheduled sends (the weekly client report that writes itself), expiring share links, per-viewer analytics (who opened what — the data-room pattern), white-labeled sending domain.

**Key entities.** BrandKit, ReportTemplate (+ versions), Report (+ versions), DataBinding (→ source pointer), Distribution (schedule/link/recipient), ViewEvent.

**Landscape.** ClientForge (Claude-powered agency reporting + churn scores); the custom-reports Claude Code skill (branded PDFs from any data source); DocSend/Papermark (data rooms, not narrative reports). The wedge: **the report engine lives where the data lives** — no exports, no reconnecting sources, and one brand kit styles every report type across all pillars.

**Guardrails.** Never invent numbers — a figure with no connected source doesn't render, it flags for review. AI narrative is always draft-for-approval. Legal/compliance reports carry the information-not-advice label.

**Open questions.**
- PDF-first or web-first? (PDF is the sendable artifact; web is the living version.)
- Which report types ship in v1 — client performance (Grow) first?
- White-labeled sending: dedicated domain per tenant in v1, or shared?
- Pricing: bundled into tiers, or per-report / per-recipient?

**Success criteria.** An agency tenant's weekly client report goes from hours of assembly to a 60-second review-and-send. Zero ungrounded numbers across all generated reports.

**Build note.** Cross-cutting: Slice 1 (brand kit + templates) rides with the Dataset Builder build — reports need the brand kit and template pipeline early. Slices 2–4 land as each pillar's data comes online, with client performance reports (Grow) as the first full vertical.

---

## Sequencing (approved by Tico 2026-09-28)

1. **Dataset Builder first.** It compounds — every downstream feature, the BriefNow build, and the model-training factory consume its output. It's also the Launch pillar's on-ramp.
2. **Legal/Compliance second.** Protective, high-retention, and the Hullcheck synergy is already built.
3. **Funding/VC third.** Needs the Boardy agentskill integration shape confirmed before Slice 1 internals are specced.
4. **CAD+Hardware fourth.** Most specialized; build it against the drone program as the reference customer.

**Cross-cutting: Branded Report Engine (§5).** Not a pillar — Slice 1 (brand kit + templates) rides with the Dataset Builder build; Slices 2–4 land as each pillar's data comes online. First full vertical: Grow client performance reports.

*End of spec — awaiting Tico's approval or changes.*
