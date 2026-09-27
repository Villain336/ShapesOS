# Batch research: Infra repos (Coolify / Documenso / Plane) + Agency-Agents catalog

Researched 2026-09-27 by Z7 (research worker). All facts verified from source (GitHub repo pages, LICENSE files, official docs). Anything unverified is marked UNVERIFIED. Nothing is from memory.

---

## PART A — INFRA REPOS

---

## Coolify

- **Repo:** https://github.com/coollabsio/coolify ("coollabsio/coolify")
- **Description:** "An open-source, self-hostable PaaS alternative to Vercel, Heroku & Netlify … deploy static sites, databases, full-stack applications and 280+ one-click services on your own servers." (README, fetched 2026-09-27)
- **Activity:** ~62,319 stars, 5,563 forks, 17,323 commits, 706 releases, active (default branch `main`).

### License
- **Apache License 2.0** — confirmed from repo metadata ("License: Apache License 2.0 (Apache-2.0)") and the `LICENSE` file in root.

### License notes
- **Clean permissive license — no controversy found.** A 2026 comparison article states "Coolify self-hosted is free forever under the Apache 2.0 license, with no feature limits, no user caps, and unlimited servers and team members."
- No additional "fair use" / non-compete riders on the open-source build (contrast with CapRover's modified-Apache discussion, which is about a different project — not Coolify).
- Coollabs runs a paid managed product, **Coolify Cloud** (~$5/mo base), but the self-hosted code is Apache-2.0 without paywalls.
- **AGPL-compat:** Apache-2.0 is one-way compatible into AGPLv3 (Apache code can be combined into an AGPLv3 work). Apache code can also be embedded/forked into Marketr's commercial tier without disclosure obligations, since Apache 2.0 imposes no copyleft. Fully compatible with AGPLv3 + commercial dual-licensing.

### Integration shape + engineering cost
- **Shape: use-as-ops-tool, not as a product component.** Coolify is deploy infrastructure. There is no product reason to embed its UI or fork its codebase; the value is as the self-host deployment plane for Marketr white-label client instances.
- **Recommended:** run Coolify on a VPS, deploy each white-label Marketr client instance (Next.js standalone + Postgres) through it with automatic SSL/backups. Treat Coolify as infra, keep it out of the product surface.
- **Engineering cost: LOW.** One-command install (`curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash` on an Ubuntu VPS); ops learning curve measured in hours. Cost is operational (one VPS ~$5/mo) rather than engineering.

### Runtime footprint
- **Languages:** PHP (Laravel) backend, JavaScript/TypeScript frontend (repo topics include `laravel`, `php`, `inertiajs`, `nextjs`, `nodejs`). Managed via Docker Compose.
- **Infra needs:** single VPS with Docker; minimum 2 CPU / 2 GB RAM (4 GB+ recommended), 20 GB+ disk, ports 80/443/8000. One control server + optional worker servers.

### Fit score: 4 / 5
- Rationale: Not mission-direct (it has nothing to do with the editor or brand-consistency), but it is the cheapest credible path to a **self-hosted white-label tier** — the agency story ("own your stack, your data, your brand"). Apache-2.0 makes it business-safe. Minus one point because it is pure infrastructure: it adds ops surface (see hosting verdict below) and zero product differentiation.

---

## Documenso

- **Repo:** https://github.com/documenso/documenso ("documenso/documenso")
- **Description:** "The Open Source DocuSign Alternative." Signing workflows, templates, teams, API, PKCS#12 document sealing. (~12,500+ stars; updated May 2026.)
- **Stack:** TypeScript / Next.js + Prisma + PostgreSQL; BullMQ/Redis for jobs; S3-compatible storage; SMTP email-driven signing flow.

### License
- **GNU AGPL-3.0** — confirmed by reading the actual `LICENSE` file at `blob/main/LICENSE` (standard "GNU AFFERO GENERAL PUBLIC LICENSE, Version 3, 19 November 2007" text).

### License notes — ⚠️ IMPORTANT nuance
- The repo is **split-license in practice**:
  - Core/community features: AGPL-3.0.
  - **Enterprise Edition:** features in `packages/ee/` are **NOT AGPL** and require a paid license key (`NEXT_PRIVATE_DOCUMENSO_LICENSE_KEY`). Per Documenso's own policy docs (fetched from `documenso/documenso`, `apps/docs/content/docs/policies/`):
    - Enterprise-gated features include: Stripe Billing Module, Organisation Authentication Portal, Document Action Reauthentication (passkeys/2FA), 21 CFR Part 11, email domains, **embed authoring** and **embed authoring white label**.
    - Their license-comparison table is explicit: **"SaaS product using Documenso API only" → Community Edition is sufficient; "White-label product with proprietary changes" → Enterprise Edition required.**
    - "If you modify Documenso and provide network access to users without complying with AGPL-3.0 source disclosure, you need an Enterprise license."
- **AGPL-compat:** The AGPL core is license-compatible with Marketr's AGPLv3 side. But **white-labeling Documenso itself (agency-branded signing UI with private modifications) triggers their paid Enterprise license** — it is not free-as-in-freedom for that scenario. API-only use without modifying their code is fine on Community Edition.

### Integration shape + engineering cost
- **Shape: API integration against a separately self-hosted Documenso instance.** Do NOT fork-and-modify (triggers EE boundary + AGPL disclosure), and do NOT embed its UI in Marketr (the white-labeled embed authoring is the paid EE feature).
- The clean pattern: host Documenso CE untouched, call its REST API + webhooks (document created/sent/viewed/signed/completed) from Marketr; render signing status inside Marketr dashboards.
- **Engineering cost: MEDIUM.** Self-hosting is Docker-Compose trivial (~5 min per their docs), but production needs care: signing-cert lifecycle (`SIGNING_CERT_B64`), SMTP, S3, Redis. API integration work is a few days of engineering plus legal-document workflow mapping.

### Runtime footprint
- **Language:** TypeScript / Next.js (same family as Marketr — easiest stack fit of the three).
- **Infra needs:** one app container + managed Postgres 14+, Redis (BullMQ), S3-compatible storage, SMTP. Comparable footprint to a small Marketr deployment.

### Fit score: 3 / 5
- Rationale: Proposals/contracts are a genuine agency white-label need, and Documenso CE's core signing + API works for it at zero software cost. But the **white-label embed itself is paywalled behind Enterprise**, which caps the dream ("fully white-labeled everything") at "co-branded-ish via API." It's a phase-2 convenience, not a moat — DocuSign/HelloSign already integrate with everything. Worth doing once agency clients actually ask for signing inside Marketr; not worth leading with.

---

## Plane

- **Repo:** https://github.com/makeplane/plane ("makeplane/plane")
- **Description:** "Open-source Jira, Linear, Monday, and ClickUp alternative. … manage tasks, sprints, docs, and triage." Project management: issues, cycles (sprints), modules (epics), views, pages (wiki), roadmaps.
- **Activity:** active (README updated within days of fetch).

### License
- **GNU AGPL-3.0** — confirmed by reading `LICENSE.txt` at `blob/master/LICENSE.txt` (full AGPLv3 text) and the README's license section.

### License notes
- Single clean AGPL-3.0 license on the community repo; no `ee/` carve-out found in the repo like Documenso's. (Third-party forks exist that unlock features gated behind Plane's paid cloud plans, but that is upstream's packaging, not a license trap in the repo itself.)
- **AGPL-compat:** Fully compatible with Marketr's AGPLv3 side. Embedding modified Plane UI into Marketr would require publishing the combined work's source under AGPL — acceptable for the open tier, incompatible with keeping the commercial tier closed unless Plane is kept as a separate, unmodified service.

### Integration shape + engineering cost
- **Shape: don't-bother (as a product component); API-only if ever needed.** Plane is an issue tracker, not a campaign object. Marketr's "Missions" are multi-step marketing campaigns — different domain model. There is no meaningful product integration to build.
- Internal-use angle: could replace an internal Trello/Notion for agency ops, but that is not a Marketr feature.
- **Engineering cost if forked: HIGH.** Polyglot monorepo (Python/Django backend + 3 React frontends + Node realtime service); fork-and-modify means inheriting a whole second product's maintenance. Embedding its UI into Marketr's design system would be a restyle project, not an integration.

### Runtime footprint
- **Languages:** Python/Django + Django REST Framework backend; Celery + RabbitMQ for async jobs; React 19 + React Router 7 frontends (web, admin, space SPAs); Node/Hocuspocus (Yjs) realtime server; Caddy reverse proxy.
- **Infra needs:** PostgreSQL 15, Redis/Valkey, RabbitMQ, MinIO (S3-compatible), multiple app services. Heaviest footprint of the three — roughly a full second product to operate.

### Fit score: 2 / 5
- Rationale: Solid open-source PM tool, but it solves **project tracking**, and Marketr's mission is the **brand-consistent editor + agentic marketing ecosystem**. No strategic overlap with the product surface; as internal tooling it's a commodity choice. Only real use: dogfooding an open PM tool inside the agency org, not the product.

---

## Verdict: Coolify "offering hosting" — AGAINST

**Recommendation: AGAINST turning Marketr into a hosting provider.** Use Coolify as internal deployment infra for white-label client instances; do NOT sell hosting as a product.

What "offering hosting" actually commits the business to:

1. **Support burden.** Hosting is a 24/7 promise: uptime SLAs, incident response, backup restores, SSL renewals, migration help. Every agency client becomes an ops ticket. Marketr is a two-person-ish operation today; hosting turns engineering time into pager duty.
2. **Abuse & spam risk.** Open or semi-open hosting is a magnet for SEO spam, phishing pages, and crypto-drainers. IP/domain reputation damage, takedown handling, and terms-of-service enforcement become a standing job — with legal exposure if you host client content you don't review.
3. **Unit economics.** VPS + bandwidth + backups + support time per client at agency scale is thin-margin work competing with Vercel/Netlify/Hetzner on price — a race to the bottom that is not Marketr's moat. The moat is the editor, the brand engine, and the agent ecosystem.
4. **Compliance & trust.** Agencies sell to clients who ask about SOC 2 / data residency; a self-run Coolify fleet has none of that, and getting it is a six-figure project.
5. **Scope creep.** "Hosting" invites requests for email hosting, DNS management, CDN, WAF — an entire second business.

**The right shape:** Coolify = the white-label deployment plane. One-click (or one-script) provisioning of isolated Marketr instances per agency client on infrastructure the agency controls. That captures the "own your stack" selling point with near-zero marginal commitment: the client owns the VPS bill, Marketr sells the software + setup. Apache-2.0 makes this legally clean.

## Verdict: Documenso × agency white-label story

**Verdict: viable as a phase-2 integration, not a flagship.** The honest picture:

- The **Community Edition core (send/sign/templates/API) is genuinely free under AGPL** and API-only use without code modifications is explicitly sanctioned by Documenso's own policy docs — so "proposals sent from Marketr, signed via self-hosted Documenso" is clean and costs only infra.
- The catch: **the white-labeled embed experience (embed authoring white label) is the paid Enterprise feature.** So the deep "signing happens invisibly inside your client's branded portal" story requires their commercial license (sales quote, priced by users/volume).
- Also note per-envelope economics: self-hosting ends DocuSign's per-envelope counting, which is the pitch to agencies — but only if signing volume justifies the ops overhead of running Documenso.
- **Recommendation:** defer until an agency client asks for contracts inside Marketr. When built, integrate via API against an unmodified CE instance; price any future white-label-signing add-on against Documenso's Enterprise quote rather than assuming it's free.

---

---

## PART B — AGENCY-AGENTS REPO

### Identity (verified from source)
- **Repo:** https://github.com/msitarzewski/agency-agents ("The Agency")
- **Tagline:** "A complete AI agency at your fingertips — From frontend wizards to Reddit community ninjas, from whimsy injectors to reality checkers. Each agent is a specialized expert with personality, processes, and proven deliverables."
- **Author:** msitarzewski; created 2025-10-13; ~154,886 stars, ~24,978 forks (fetched 2026-09-27). Also ships a native desktop app (agencyagents.app) for one-click install into Claude Code, Cursor, Copilot, etc.
- **Format:** one Markdown persona file per agent (frontmatter: name, description, color, emoji, vibe + identity/mission/rules/deliverables/workflow/success-metrics body) + install/convert shell scripts. MIT licensed.

### License
- **Repo license: MIT** (confirmed from repo metadata + README badge). No per-agent license variations found — single root `LICENSE`, no per-file license headers documented in the README. Everything is commercially reusable, including inside Marketr's commercial tier, with only attribution required. (Per-file license text not individually audited; based on repo structure.)

### Agent count
- README roster (fetched 2026-09-27) lists **285 agents across 18 divisions**. (Third-party catalogs report 230–232; the README I read is the authoritative count as of this fetch.)

### Full agent catalog (name — one-line purpose; grouped by division)

**Engineering (70):** Frontend Developer — React/Vue/Angular UI implementation & performance · Backend Architect — API design, database architecture, scalability · Mobile App Builder — iOS/Android, React Native, Flutter apps · AI Engineer — ML models, deployment, AI integration · DevOps Automator — CI/CD, infrastructure automation, cloud ops · Network Engineer — Cisco/Juniper/Palo Alto config, BGP/OSPF, ACLs · Rapid Prototyper — fast POCs and MVPs · Senior Developer — Laravel/Livewire advanced patterns · Filament Optimization Specialist — Filament PHP admin UX restructure · Autonomous Optimization Architect — LLM routing & cost guardrails · Embedded Firmware Engineer — bare-metal/RTOS ESP32/STM32 firmware · Incident Response Commander — incident management & post-mortems · Solidity Smart Contract Engineer — EVM contracts, gas optimization, DeFi · Codebase Onboarding Engineer — read-only codebase exploration & explanation · Technical Writer — developer docs, API reference, tutorials · WeChat Mini Program Developer — WeChat ecosystem apps & payments · Code Reviewer — constructive code review, security, maintainability · Database Optimizer — schema design, query/index tuning (Postgres/MySQL) · Git Workflow Master — branching strategies, conventional commits · Software Architect — system design, DDD, architectural trade-offs · SRE — SLOs, error budgets, observability, chaos engineering · AI Data Remediation Engineer — self-healing data pipelines, air-gapped SLMs · Data Engineer — data pipelines, lakehouse, ETL/ELT · Feishu Integration Developer — Feishu/Lark Open Platform bots & workflows · CMS Developer — WordPress/Drupal themes, plugins, content architecture · Email Intelligence Engineer — email parsing/MIME extraction into structured AI context · Voice AI Integration Engineer — speech-to-text pipelines, Whisper, diarization · IT Service Manager — ITIL 4 service management · Minimal Change Engineer — minimum-viable diffs, no scope creep · OrgScript Engineer — OrgScript grammar & AST validation · Prompt Engineer — LLM prompt design & optimization · Multi-Agent Systems Architect — multi-agent pipeline design, topology, trust, failure recovery · Drupal Shopping Cart Engineer — Drupal Commerce storefronts · WordPress Shopping Cart Engineer — WooCommerce storefronts · Payments & Billing Engineer — PSP integration, idempotent payments, subscriptions · Internationalization Engineer — ICU MessageFormat, RTL, CLDR, pseudo-localization · Drupal Performance Engineer — Drupal caching, DB tuning, Core Web Vitals · WordPress Performance Engineer — WP caching, query/asset optimization · Section 508 Accessibility Specialist — US federal 508/WCAG, VPAT/ACR authoring · USWDS Developer — US Web Design System gov UI components · Search Relevance Engineer — search ranking, embeddings, relevance tuning · Identity & Access Engineer — OAuth/OIDC/SAML, SSO, RBAC/ABAC · Realtime Collaboration Engineer — CRDTs/OT, presence, offline sync · Desktop App Engineer — Electron/Tauri cross-platform apps · Mobile Release Engineer — App Store/Play submission, staged rollout · Video Streaming Engineer — HLS/DASH, ABR, codecs, CDN · FinOps Engineer — cloud cost engineering, unit economics · WebAssembly Engineer — WASM/WASI, Rust/C++→WASM · API Platform Engineer — API gateways, versioning, rate limiting, dev portals · Database Reliability Engineer — HA/replication, failover, PITR backups · Developer Tooling Engineer — CLIs & internal developer tooling · IoT Fleet Engineer — device provisioning, MQTT telemetry, OTA · RAG Pipeline Engineer — production RAG: chunking, retrieval quality, reranking, evals · GaussDB Expert Engineer — Huawei GaussDB OLTP performance & HA · Privacy Engineer — PII discovery, data minimization, DSAR/deletion pipelines · Rust Refactoring Specialist — behavior-preserving Rust refactors · LLM Post-Training Engineer — SFT/DPO/GRPO/RLVR experiment gating & checkpoint integrity · Data Visualization Engineer — perceptually honest, colorblind-safe data viz · Knowledge Graph Engineer — knowledge graphs, entity extraction, graph-enhanced RAG · China Network Engineer — Huawei/H3C/Ruijie routing, MLPS 2.0 borders · Platform Engineer — internal developer platforms, golden paths, IDPs · PDF Engine Architect — deterministic HTML-to-PDF, tagged PDF/UA, PDF/A · ATS Validator Architect — resume parseability, ATS ingestion pipelines · Universal Document Compiler — schema-agnostic doc ASTs → proposals/specs/dossiers.

**Design (10):** UI Designer — visual design, component libraries, design systems · UX Researcher — user testing, behavior analysis · UX Architect — technical CSS systems, implementation guidance · Brand Guardian — brand identity, consistency, positioning · Visual Storyteller — visual narratives, brand storytelling · Whimsy Injector — personality, delight, micro-interactions · Image Prompt Engineer — AI image-generation prompts · Inclusive Visuals Specialist — representation & bias mitigation in AI imagery · Persona Walkthrough Specialist — persona-driven cognitive walkthroughs per scroll position · UI Finish-Gate Reviewer — anti-generic UI finish gate via evidence + design contract.

**Paid Media (7):** PPC Campaign Strategist — Google/Microsoft/Amazon Ads account architecture & bidding · Search Query Analyst — search-term analysis, negative keywords, intent mapping · Paid Media Auditor — 200+ point account audits, competitive analysis · Tracking & Measurement Specialist — GTM/GA4, conversion tracking, CAPI · Ad Creative Strategist — RSA copy, Meta creative, PMax assets · Programmatic & Display Buyer — GDN/DSPs, ABM display · Paid Social Strategist — Meta/LinkedIn/TikTok social ad programs.

**Sales (10):** Outbound Strategist — signal-based prospecting, multi-channel sequences · Discovery Coach — SPIN/Gap/Sandler question design & call structure · Deal Strategist — MEDDPICC qualification, win planning · Sales Engineer — technical demos, POC scoping, battlecards · Proposal Strategist — RFP responses, win themes, narrative structure · Pipeline Analyst — forecasting, pipeline health, RevOps · Account Strategist — land-and-expand, QBRs, stakeholder mapping · Sales Coach — rep development, call coaching · Sales Outreach — cold prospecting cadences, objection handling · Offer & Lead Gen Strategist — offers & lead magnets.

**Marketing (36):** Growth Hacker — rapid acquisition, viral loops, experiments · Content Creator — multi-platform content, editorial calendars · Twitter Engager — real-time engagement, thought leadership · X/Twitter Intelligence Analyst — social listening, trend detection, brand risk · TikTok Strategist — viral content, algorithm optimization · Instagram Curator — visual storytelling, community building · Reddit Community Builder — authentic engagement, community trust · App Store Optimizer — ASO, discoverability · Social Media Strategist — cross-platform strategy & campaigns · Xiaohongshu Specialist — lifestyle content, China Gen Z · WeChat Official Account Manager — subscriber engagement, content marketing · Zhihu Strategist — thought-leadership Q&A authority building · Baidu SEO Specialist — Baidu optimization, China SEO, ICP compliance · Bilibili Content Strategist — danmaku culture, UP主 growth · Carousel Growth Engine — TikTok/IG carousels, autonomous publishing · LinkedIn Content Creator — personal branding, B2B content · China E-Commerce Operator — Taobao/Tmall/Pinduoduo, live commerce · Kuaishou Strategist — grassroots growth in lower-tier markets · SEO Specialist — technical SEO, content strategy, link building · Book Co-Author — thought-leadership ghostwriting · Cross-Border E-Commerce Specialist — Amazon/Shopee/Lazada full-funnel · Douyin Strategist — short-video marketing, algorithm · Livestream Commerce Coach — host training, live-room optimization · Podcast Strategist — Chinese podcast market operations · Private Domain Operator — WeCom private traffic ecosystems · Short-Video Editing Coach — post-production workflows & training · Weibo Strategist — Sina Weibo operations & growth · Global Podcast Strategist — show positioning, monetisation, sponsorships · AI Citation Strategist — AEO/GEO, brand visibility across ChatGPT/Claude/Gemini/Perplexity · China Market Localization Strategist — full-stack China GTM · Video Optimization Specialist — YouTube algorithm, chapters, thumbnails · AEO Foundations Architect — llms.txt, AI-aware robots.txt, agent discovery files · Agentic Search Optimizer — WebMCP & making sites usable by AI browsing agents · Email Marketing Strategist — lifecycle email & deliverability · Multi-Platform Publisher — one-click Chinese multi-platform publishing · PR & Communications Manager — PR, media relations, crisis comms.

**Product (5):** Sprint Prioritizer — agile planning, feature prioritization · Trend Researcher — market intelligence, competitive analysis · Feedback Synthesizer — user-feedback analysis & insight extraction · Behavioral Nudge Engine — behavioral psychology, nudge design, engagement · Product Manager — full-lifecycle product ownership, PRDs, roadmaps, GTM.

**Project Management (7):** Studio Producer — high-level orchestration, portfolio management, strategic alignment · Project Shepherd — cross-functional coordination, timeline management · Studio Operations — day-to-day efficiency, process optimization · Experiment Tracker — A/B tests, hypothesis validation · Senior Project Manager — realistic scoping, spec→task conversion · Jira Workflow Steward — Git/Jira traceability discipline · Meeting Notes Specialist — structured summaries, decisions, action items.

**Testing (9):** Evidence Collector — screenshot-based QA, visual proof · Reality Checker — evidence-based production-readiness certification · Test Results Analyzer — test metrics analysis, coverage reporting · Performance Benchmarker — speed/load testing & tuning · API Tester — API validation, integration testing · Tool Evaluator — technology assessment & selection · Workflow Optimizer — process analysis & efficiency gains · Accessibility Auditor — WCAG auditing, assistive-tech testing · Test Automation Engineer — Playwright/Cypress E2E, flake elimination, CI parallelization.

**Security (12):** Security Architect — threat modeling, secure-by-design · Application Security Engineer — SDLC security, SAST/DAST · Penetration Tester — authorized pentests, red team ops · Cloud Security Architect — zero trust, cloud-native defense · Incident Responder — DFIR, breach investigation · Threat Intelligence Analyst — adversary tracking, ATT&CK mapping · Threat Detection Engineer — SIEM rules, threat hunting · Senior SecOps Engineer — secrets scanning, secure-by-default submissions · Compliance Auditor — SOC 2, ISO 27001, HIPAA, PCI-DSS · Blockchain Security Auditor — smart-contract audits · AI-Generated Code Security Auditor — security review of AI/vibe-coded apps · Secrets & Credential Hygiene Engineer — secrets lifecycle, rotation, leak response.

**Support (6):** Support Responder — customer service, issue resolution · Analytics Reporter — BI dashboards, KPI tracking · Finance Tracker — financial planning, cash flow · Infrastructure Maintainer — system reliability & monitoring · Legal Compliance Checker — compliance & regulatory review · Executive Summary Generator — C-suite summaries, decision support.

**Spatial Computing (6):** XR Interface Architect — spatial interaction design · macOS Spatial/Metal Engineer — Swift/Metal, Vision Pro native · XR Immersive Developer — WebXR browser AR/VR · XR Cockpit Interaction Specialist — cockpit-based immersive controls · visionOS Spatial Engineer — Apple Vision Pro development · Terminal Integration Specialist — CLI tools, terminal workflows.

**Specialized (58):** Agents Orchestrator — multi-agent coordination, workflow management · LSP/Index Engineer — Language Server Protocol, code intelligence · Sales Data Extraction Agent — Excel monitoring, sales metric extraction · Data Consolidation Agent — sales data aggregation, dashboard reports · Report Distribution Agent — automated territory-based report delivery · Agentic Identity & Trust Architect — agent identity, authentication, audit trails · Identity Graph Operator — shared identity resolution for multi-agent systems · Accounts Payable Agent — autonomous payment execution (crypto/fiat/stablecoins) · Cultural Intelligence Strategist — global UX, cultural exclusion audits · Developer Advocate — community building, DX content · Model QA Specialist — ML audits, interpretability · ZK Steward — Zettelkasten knowledge management · MCP Builder — Model Context Protocol servers, agent tooling · Document Generator — PDF/PPTX/DOCX/XLSX generation from code · Automation Governance Architect — automation governance, n8n workflow auditing · Corporate Training Designer — enterprise training curricula · Personal Growth Mentor — goal clarity, habit systems · Government Digital Presales Consultant — China ToG presales · Healthcare Marketing Compliance — China healthcare ad compliance · Recruitment Specialist — talent acquisition, sourcing · Study Abroad Advisor — international education planning · Supply Chain Strategist — procurement strategy · Workflow Architect — workflow discovery, mapping, specification · Salesforce Architect — multi-cloud Salesforce design · French Consulting Market Navigator — French IT freelance consulting (ESN/portage) · Korean Business Navigator — Korean business culture & relationship mechanics · Civil Engineer — structural analysis, multi-standard building codes · Customer Service — omnichannel support, retention · Healthcare Customer Service — HIPAA-aware patient support · Hospitality Guest Services — reservations, concierge, loyalty · HR Onboarding — pre-boarding, 30-60-90 plans · Language Translator — Spanish↔English, dialect awareness · Legal Billing & Time Tracking — law-firm time capture, IOLTA compliance · Legal Client Intake — prospect qualification, conflict screening · Legal Document Review — contract review, risk flagging · Loan Officer Assistant — borrower intake, TRID compliance · Real Estate Buyer & Seller — transaction coordination · Retail Customer Returns — returns processing, fraud prevention · Business Strategist — management-consulting strategy (competitive analysis, market entry, growth) · Change Management Consultant — ADKAR/Kotter/Prosci transformation · Chief of Staff — executive coordination, decision routing · Customer Success Manager — onboarding, health, retention, QBRs · Grant Writer — grant proposals & budgets · Medical Billing & Coding Specialist — ICD-10/CPT, revenue cycle · Pricing Analyst — pricing models & margin optimization · Chief Financial Officer — capital allocation, FP&A, M&A finance · ESG & Sustainability Officer — ESG programs & disclosure · Data Privacy Officer — GDPR/CCPA compliance, DPIAs · Operations Manager — Lean/Six Sigma operations · M&A Integration Manager — post-merger 100-day plans · Organizational Psychologist — team dynamics, culture health · Strategy Duel Agent — game theory & 36 stratagems, adversarial simulation · FedRAMP & RMF Compliance Engineer — federal cloud authorization (NIST 800-53, OSCAL) · Codebase Archaeologist — multi-tool codebase drift audits · Resume Tailor — JD mapping, ATS keyword alignment · Aging Parent Care Companion — family caregiver decision-support · Master Plan Architect — architectural teaching, red-team plan critique · Focus Music Architect — focus-music prompt engineering, neuroacoustics.

**Finance (5):** Bookkeeper & Controller — month-end close, GAAP, audit readiness · Financial Analyst — financial modeling, forecasting, scenario analysis · FP&A Analyst — budgeting, rolling forecasts, business reviews · Investment Researcher — due diligence, equity research · Tax Strategist — tax optimization, multi-jurisdictional compliance.

**Game Development (21):** Game Designer — systems design, GDD, economy balancing · Level Designer — layout theory, encounter design · Technical Artist — shaders, VFX, art-to-engine optimization · Game Audio Engineer — FMOD/Wwise, adaptive music · Narrative Designer — branching dialogue, lore architecture · Economy Designer — virtual currencies, F2P monetization · Unity Architect — ScriptableObjects, DOTS/ECS · Unity Shader Graph Artist — URP/HDRP shaders · Unity Multiplayer Engineer — Netcode for GameObjects, Relay/Lobby · Unity Editor Tool Developer — custom editor tooling, pipeline automation · Unreal Systems Engineer — C++/Blueprint hybrid, GAS · Unreal Technical Artist — Material Editor, Niagara, PCG · Unreal Multiplayer Architect — replication graphs, dedicated servers · Unreal World Builder — World Partition, HLOD, streaming · Godot Gameplay Scripter — GDScript 2.0, scene composition · Godot Multiplayer Engineer — MultiplayerAPI, authority models · Godot Shader Developer — shading language, compute shaders · Blender Addon Engineer — bpy add-ons, DCC pipeline automation · Roblox Systems Scripter — Luau, server-authoritative architecture · Roblox Experience Designer — engagement loops, retention, monetization · Roblox Avatar Creator — UGC pipeline, rigging, marketplace submission.

**Academic (6):** Anthropologist — cultural systems, kinship, belief systems · Geographer — physical/human geography, cartography · Historian — historical analysis, period detail · Narratologist — narrative theory, story structure · Psychologist — personality theory, motivation · Statistician — inference & experiment design.

**GIS (13):** Technical Consultant — GIS strategy, technology roadmaps · Solution Engineer — Esri + FOSS4G prototyping · GIS Analyst — map production, data QC · Spatial Data Engineer — geospatial ETL, CRS reprojection · Geoprocessing Specialist — ArcPy automation, custom tools · GIS QA Engineer — topology validation, metadata audit · GeoAI/ML Engineer — feature extraction, object detection from imagery · BIM/GIS Specialist — Revit/IFC→GIS, digital twins · 3D & Scene Developer — Cesium, 3D Tiles, point clouds · Spatial Data Scientist — spatial statistics, hotspot detection · Drone/Reality Mapping — photogrammetry, orthomosaic, DTM/DSM · Web GIS Developer — MapLibre/Leaflet, real-time dashboards · Cartography Designer — color theory, basemap aesthetics.

**Healthcare (3):** Clinical Evidence Agent — evidence standards, diagnostic-authority boundaries · Sovereign Health Systems Agent — government health mandates, UHC policy · Healthcare Innovation Strategist — healthcare founder narrative architecture.

**Research (1):** Research Synthesist — literature review, evidence synthesis, citation tracing.

### Top 5 recommendations for Marketr's architecture

| # | Agent (division) | Maps to | Justification (one line) |
|---|---|---|---|
| 1 | 🕸️ Multi-Agent Systems Architect (Engineering) | **Playbooks** | Its specialty is multi-agent pipeline topology, context flow, trust, and failure recovery — exactly the runtime mechanics a Playbook engine needs. |
| 2 | 🗺️ Workflow Architect (Specialized) | **Playbooks** | "Mapping every path through a system before code is written" is the authoring pattern for reusable workflows — the design-time half of Playbooks. |
| 3 | 🎯 Studio Producer (Project Management) | **Missions** | High-level orchestration, portfolio management, and strategic alignment is the Mission runner's job description (multi-step campaigns as managed productions). |
| 4 | 🎯 Business Strategist (Specialized) | **Chief Strategy Agent** | Management-consulting-grade competitive analysis, market entry, and growth planning — the strategic reasoning template the Chief should reason with. |
| 5 | 🎭 Agents Orchestrator (Specialized) | **Chief Strategy Agent** | Its coordination/workflow-management pattern is the dispatch layer — how the Chief fans out to, supervises, and aggregates specialist sub-agents. |

**Also worth mining (secondary):** 🎭 Brand Guardian (Design) — on-brand enforcement, directly matches "the editor that keeps clients on-brand"; 🔮 AI Citation Strategist + 🏗️ AEO Foundations Architect (Marketing) — AEO/GEO patterns for Marketr's AI-search visibility tracking; 🚀 Growth Hacker (Marketing) — experiment-loop seed for Missions; 🐑 Project Shepherd (Project Management) — Mission execution tracking; 📣 PR & Communications Manager (Marketing) — campaign comms; 🧭 Chief of Staff (Specialized) — decision-routing pattern for the Chief's executive layer.

**Caveats:** These are *persona prompt files*, not executable agents — the value is their system-prompt structure (identity, mission, rules, deliverables, workflow, success metrics), which maps cleanly onto Marketr's EXPERT-CONSTITUTION.md prompt-layer approach. Quality varies by agent (community-contributed); treat as seeds to adapt, not drop-in prompts. No per-agent license differences were found (all MIT under the repo root), but per-file text was not individually audited.

---

## Sources
- Coolify repo: https://github.com/coollabsio/coolify (metadata + README, 2026-09-27)
- Coolify licensing note: https://dev.to/jamilxt/cloud-in-a-bottle-vs-coolify-which-one-should-actually-host-your-personal-cloud-pmh
- Documenso LICENSE: https://github.com/documenso/documenso/blob/main/LICENSE (AGPLv3 text verified)
- Documenso licensing policy: https://github.com/documenso/documenso/blob/HEAD/apps/docs/content/docs/policies/enterprise-edition.mdx and `policies/licenses.mdx`, `policies/community-edition.mdx`
- Documenso stack/self-host: https://github.com/hinvec/security-scanned-skills/blob/HEAD/skills/documenso-open-source-document-signing/SKILL.md
- Plane LICENSE: https://github.com/makeplane/plane/blob/master/LICENSE.txt (AGPLv3 text verified)
- Plane stack: https://github.com/lightbridge-ks/software-design-explore/blob/HEAD/src/content/docs/case-studies/apps/plane_system_oop_architecture.md
- Agency-Agents repo + roster: https://github.com/msitarzewski/agency-agents (README roster, 2026-09-27)
