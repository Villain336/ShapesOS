# Phase 12 Batch Content — OSS Repo Research
Researched 2026-09-27 by Z7 research worker. Every license fact verified against the live repo (repo page + LICENSE file), never from memory. UNVERIFIED marks a fact that could not be source-confirmed.

---

## 1. Penpot
Repo: https://github.com/penpot/penpot (~60.4k stars, default branch `develop`)

**License:** Mozilla Public License 2.0 (MPL-2.0) — confirmed on the live repo page and in the README ("This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0… Copyright (c) KALEIDOS SUBSIDIARY SL").

**License notes/changes:** No recent relicense found; Penpot has been MPL-2.0 since its Kaleidos origins. Paid tier exists separately: **Penpot Enterprise** (SSO, admin console, governance) — monetized via hosted/enterprise offering, not via license change.

**AGPL-compat:** ✅ MPL-2.0 is explicitly AGPL-compatible (§3.3 "Larger Work" provision — MPL files can be combined into an AGPLv3 work; only *modified MPL-licensed files themselves* must stay MPL and their changes disclosed). No network-copyleft of its own.

**Integration shape + cost:**
- **Don't fork.** It's a full product (Clojure/ClojureScript everywhere + Rust→WASM Skia render engine). Forking = adopting a second language stack and a multi-service platform.
- Realistic shapes: (a) **MCP server** (in-repo `mcp/`, official, 5 tools: overview, execute_code, export, import) — agent-driven design round-trips; (b) **RPC REST API + webhooks** (personal access tokens) — pull designs/assets into Marketr; (c) **plugin system** — build a Marketr export/import plugin inside Penpot's sandbox.
- Cost: MCP/API bridge = **low–medium** (weeks, mostly token plumbing). A plugin = medium. A fork = **very high** (quarters, wrong-language team).

**Runtime footprint:** Heavy. Frontend SPA + Clojure/JVM backend + Chromium exporter service + Postgres + Redis/Valkey. Its own Docker Compose world — cannot sidecar *inside* the Next.js app; it is a separate service (or just use design.penpot.app / penpot.app SaaS).

**Fit score: 2/5.** Wrong layer for Marketr's mission. Penpot is a *product-UI design tool for design teams*; Marketr needs *on-brand marketing-asset generation*. The only live value is an MCP/API bridge for design-token round-trip (import a client's design system into Marketr's brand kit) — a nice-to-have, not a foundation.

---

## 2. Ghost
Repo: https://github.com/TryGhost/Ghost (~55.4k stars)

**License:** MIT — confirmed on the live repo page (GitHub license field: "MIT License (MIT)") and on Wikipedia's infobox. Core repo is MIT; note TryGhost/Docs is a separate closed-source repo, but the product itself is MIT.

**License notes/changes:** No relicense — MIT since 2013 Kickstarter launch. Business runs on Ghost(Pro) hosting, not license changes.

**AGPL-compat:** ✅ MIT combines cleanly into AGPLv3. Zero embedding restrictions.

**Integration shape + cost:**
- **Sidecar via API, not a fork.** Ghost exposes a Content API (public content) and Admin API (JWT; publish, manage). Run Ghost as its own service; Marketr's agents publish through the API.
- Cost: **medium**. Ghost is a whole CMS (themes in Handlebars, members/newsletters, Stripe) — adopting the codebase wholesale is a second product; API-driven publishing is cheap.
- Honest alternative: Marketr doesn't need Ghost's editor or membership stack — if the goal is "AI content engine → publish", the Admin API alone suffices.

**Runtime footprint:** Node.js + MySQL (or SQLite in dev); official Docker images; moderate weight. Its own service/port — not embeddable in the Next.js app.

**Fit score: 3/5.** The obvious wire: Marketr's content engine → publish to client blogs via Ghost Admin API. But Marketr has its own AI content engine; Ghost only matters if Marketr wants to *host client blogs/newsletters* as a retention loop — a plausible but Phase-later wedge, and WordPress-first is already the stated direction.

---

## 3. Payload
Repo: https://github.com/payloadcms/payload (~44.9k stars)

**License:** MIT — confirmed on the live repo page ("MIT License (MIT)", `LICENSE.md` at root) and in the official docs ("fully open source with an MIT license").

**License notes/changes:** No relicense. Payload raised prices on cloud/hosting, never changed the code license.

**AGPL-compat:** ✅ MIT combines cleanly into AGPLv3. Zero restrictions — this is the cleanest license in the batch for a dual-licensed product.

**Integration shape + cost:**
- **Embed as a module — the Payload superpower.** `@payloadcms/next` runs Payload *inside* the Next.js app; Local API (`payload.find()`, typed, no HTTP) from Server Components; code-first TS collections; auto admin panel + REST/GraphQL.
- Cost: **medium**. Content modeling is code (fast for a TS team), migrations are real work, admin UI is generated (free). No new language, no new service topology.
- Use for: Marketr's internal content models — templates library, brand-kit registry, playbook/mission content, knowledge-base chunks admin — all as typed collections.

**Runtime footprint:** Light. Same Node process as Marketr's Next.js app. Needs Postgres (Marketr already runs durable PG16 on 5433) or MongoDB/SQLite. Zero new infra.

**Fit score: 4/5.** The only CMS in this batch that *dissolves into* Marketr's existing stack. MIT removes all legal friction; Next.js-native removes all ops friction.

---

## 4. Strapi — ⚠️ FLAG (license verified)
Repo: https://github.com/strapi/strapi (~73.2k stars, default branch `develop`)

**License:** **Open-core: MIT Expat for Community Edition + proprietary license for Enterprise Edition code.** Verified from the live LICENSE file on `develop`:
- Code *not* under an `ee/` directory and used without a Strapi Cloud account → "MIT Expat" license (full MIT text in the file).
- Anything under an `ee/` directory → licensed under `packages/core/admin/ee/LICENSE` (proprietary), unless you signed an alternative agreement or use Strapi Cloud.
- GitHub reports the repo license as "Other (NOASSERTION)" because of this combined file — npm packages declare `"license": "SEE LICENSE IN LICENSE"`.

**License notes/changes:** **No 2026 relicense.** The open-core split dates to **July 2020** (Strapi Enterprise Edition launch — verified via Strapi's own announcement on dev.to). Community Edition has been MIT throughout. The "change" in the air around Strapi is the 2020 EE carve-out, not a recent event. Third-party plugin authors increasingly dual-license (e.g. AGPL-3.0 + commercial seen 2026-09-03), but core is unchanged.

**AGPL-compat:** ⚠️ **CE-only, with a poison edge.** MIT CE code combines into AGPLv3 fine. But the moment an agency white-label deployment touches an EE feature (RBAC, audit logs, review workflows, SSO — all EE-gated at runtime, license-pinged), that deployment is under a proprietary license with Strapi, Inc. — it cannot ship inside an AGPL or closed commercial bundle without their terms. For an AGPL+commercial dual-licensed product, you must firewall CE/EE strictly, forever.

**Integration shape + cost:**
- **Sidecar service only.** Koa.js HTTP server + React/Redux admin; its own Node process, own DB (SQLite/PG/MySQL/MariaDB); REST + GraphQL auto-generated; plugin system. Cannot live inside Next.js.
- Cost: **medium–high**. New service topology (deploy, migrate, back up, monitor), UI-driven content modeling is click-ops (doesn't version in git like Payload), and the plugin ecosystem's best pieces trend toward EE or paid.

**Runtime footprint:** Moderate. Own Node process; official Docker via community tooling (no official images); DB required. Heavier operationally than Payload for the same outcome.

**Fit score: 2/5.** Bigger community and more plugins than Payload, but the EE carve-out is a standing legal tax on a dual-licensed white-label product, and it can't share Marketr's process/DB. Payload beats it on every axis that matters here.

---

## 5. GrapesJS
Repo: https://github.com/GrapesJS/grapesjs (~26.3k stars, default branch `dev`)

**License:** **BSD 3-Clause** — stated in the official README's License section ("BSD 3-clause"; verified on the live repo page; GitHub metadata shows NOASSERTION only because root `LICENSE` is a symlink). No relicense.

**License notes/changes:** None on the core framework. Commercial push is the separate **Studio SDK** (paid embeddable editor at app.grapesjs.com) — the open framework stays BSD.

**AGPL-compat:** ✅ BSD-3 combines cleanly into AGPLv3. Zero restrictions.

**Integration shape + cost:**
- **npm library — the cheapest integration in this batch.** `npm i grapesjs`, `grapesjs.init({ container })`; `@grapesjs/react` wrapper exists; block manager / style manager / layers / asset manager are all pluggable; presets for webpage + newsletter + MJML; storage adapters (local, remote, IndexedDB, Firestore).
- Cost: **low–medium**. A week or two to a branded block library (wire Marketr brand kits → GrapesJS blocks, custom storage adapter → Marketr backend, export pipeline → HTML). This is a *framework*, not a product — you build *your* editor on it.

**Runtime footprint:** Negligible. Pure client-side JS/CSS; no server, no DB. Lives inside the Next.js app as a component.

**Fit score: 4/5.** Best-in-class for the landing-page/email-newsletter surface. See strategic verdict #2 below — complementary to, not overlapping, the Konva canvas.

---

## 6. Remotion — ⚠️ FLAG (license verified)
Repo: https://github.com/remotion-dev/remotion (~60.7k stars)

**License:** **Custom "Remotion License" — source-available, NOT open source (not OSI-approved).** Verified from the live `LICENSE.md` on `main`:
- **Free License:** individuals, non-profits, for-profit orgs with **up to 3 employees**, and evaluators — may use commercially *to create videos and images*, and may modify for their own use case.
- **Company License required** for for-profit orgs above that threshold — buy at remotion.pro.
- **Disallowed:** copying/modifying Remotion code *for the purpose of selling, renting, licensing, relicensing, or sublicensing your own derivative of Remotion*.
- README warns: "Be aware that Remotion has a special license and requires obtaining a company license in some cases."

**License notes/changes:** The two-tier custom license is **long-standing, not new** — company-license pricing tiers date to ~2022 ($15/seat/mo → $25/seat/mo per a 2026 review). What *is* current: the in-progress **Remotion 5.0 license update** (migration doc, fork `iamshankhadeep/remotion` mirrors the official 5.0-migration.mdx): (1) **contractors now count toward team size** (closes the contractors-only loophole), (2) company licenses bound to new written T&Cs. Treat 5.0's license as stricter, not looser.

**AGPL-compat:** ❌ **Incompatible as a bundled dependency.** It's not an OSI license; you can't satisfy its company-license requirement inside an AGPL distribution, and the no-resale-derivatives clause conflicts with redistribution. Launchabl (>3 people) would need a Company License to use it at all. Additionally the 5.0 T&Cs narrow but still gate **embedding the Player in products** — the exact shape a Marketr video feature would take. UNVERIFIED: current per-seat pricing at remotion.pro (not fetched; historical $25/seat/mo).

**Integration shape + cost:**
- Shapes: `@remotion/player` embed for previews + server-side `renderMedia` in a worker for MP4 output; Lambda render path on AWS.
- Cost: **medium engineering, high license+ops friction.** Rendering boots Chromium and renders frame-by-frame — heavy compute per video; Lambda/AWS render costs are separate from the license. You'd be building a video pipeline on a dependency that bills *your company* per seat and restricts how clients embed output.

**Runtime footprint:** Heavy at render time. Node + headless Chromium; ffmpeg bundled. Not a sidecar you forget about — it's a render farm.

**Fit score: 2/5.** Best-in-class DX for programmatic video (React compositions, word-karaoke captions), but the license is a standing tax on exactly the company that would ship it, and the strategic lane (agentic video) is better served by owning the pipeline (ffmpeg-native) or a cleanly-licensed alternative. Optional BYO plugin for power users who bring their own company license — never a core dependency.

---

## 7. OpenNotebook
Repo: https://github.com/lfnovo/open-notebook (~39.6k stars)

**License:** MIT — confirmed on the live repo page ("MIT License (MIT)", `LICENSE` at root). No relicense.

**AGPL-compat:** ✅ MIT combines cleanly into AGPLv3.

**Integration shape + cost:**
- **Sidecar via REST API.** FastAPI backend (`:5055`, full REST API + `/docs`), Next.js frontend (`:8502`), SurrealDB for storage. Docker Compose deploy; 18+ LLM providers; podcast generation; vector+fulltext search.
- Cost: **medium–high.** Separate Python stack + SurrealDB + LLM keys to operate per deployment; it's a *research product*, so integration means either iframing its UI (clunky white-label) or re-implementing its flows against its API (at which point you own the UX anyway).

**Runtime footprint:** Moderate–heavy. Python + SurrealDB + embedding/LLM inference (local Ollama optional, or API keys). Its own Compose world.

**Fit score: 2/5.** It's a good product in a lane Marketr doesn't occupy: Marketr already has a 5,924-chunk Tier 1S corpus, RAG, and the Knowledge Brain. Ingesting OpenNotebook would duplicate infrastructure for research-notebook UX that isn't "the editor that keeps clients on-brand." Take inspiration (source/citation discipline, transformation UX) — don't adopt.

---

## 8. Clip Forge
**Best match: https://github.com/sjbuilds04/clip-forge** — the literal name match ("🎬 ClipForge — AI-powered video clipping studio").

**License:** MIT — confirmed on the live repo page and README ("MIT — do whatever you want").

**⚠️ Maturity caveat (verified):** created **2026-07-23**, **2 commits, 5 stars, 2 forks, 0 releases**. This is a prototype, not a project — no community, no track record, single-author velocity unknown.

**What it is:** Next.js 15 + React 19 frontend, FastAPI + SQLAlchemy + SQLite backend, ffmpeg cutting, faster-whisper (local) or Groq Whisper cloud transcription, Groq LLM scoring clips 0–100 for "viral potential", 9:16 reel geometry, burned-in captions, Google Drive import/export. Docker Compose.

**Runner-up candidate:** `nitishrh07/clipping-tool` — also MIT-era-looking local AI clipper (yt-dlp → faster-whisper → ffmpeg, fully offline, no API keys), Python stack. License **UNVERIFIED** (no license file seen in fetched README). Less product, more script.

**AGPL-compat:** ✅ MIT (best match) combines cleanly.

**Integration shape + cost:**
- **Don't adopt; extract the pipeline pattern.** The valuable IP is a 5-line pipeline: segment → transcribe (whisper) → score moments (LLM) → cut/reframe (ffmpeg) → caption-burn. Rebuilding that inside Marketr's stack is days-to-weeks; adopting a 2-commit repo buys you unmaintained code with no tests.
- Cost of real use: **medium-high ops.** Whisper transcription + ffmpeg rendering per video is GPU/CPU-heavy; Groq free tier is a rate-limited crutch, not infrastructure.

**Runtime footprint:** Moderate–heavy at job time. Python backend + ffmpeg + whisper model (~150MB–1.5GB download) per worker. Sidecar service.

**Fit score: 2/5.** Shorts-clipping is adjacent to Marketr's video ambitions (faith-tiktok/Unicorn Watch lanes) but not to *Marketr's* mission. If Tico wants viral-clip scoring, rebuild the pipeline natively; don't depend on a 2-commit repo.

---

# Strategic verdicts

## Verdict 1: Forking Penpot — redundant AND insane. Don't.
Blunt version: you'd be adopting a **Clojure/ClojureScript + Rust/WASM** platform to rebuild an editor you already finished. Marketr's native Konva canvas (text, shapes, layers, undo, charts, batch) is *further along* than any fork would be on day 90, it's in the team's language (TypeScript), and it's already on-brand by design. Penpot is also the wrong *kind* of editor — it's a product-UI design tool (components, variants, design tokens, dev handoff), not a marketing-asset generator. A fork inherits: a second language toolchain, a 4-service runtime (JVM backend, exporter, PG, Redis), MPL file-level copyleft bookkeeping, and a product surface (design systems management) Marketr doesn't need. The only Penpot touchpoint worth a look: its **MCP server + RPC API** as a bridge to import a client's design tokens/components *into* Marketr's brand kit — low cost, optional, deferrable.

## Verdict 2: GrapesJS vs the Konva canvas — complementary, not overlap.
Different tools, different outputs, different users-in-the-moment:
- **Konva canvas** = pixel-precise *design* surface → social graphics, ad creatives, thumbnails, brand assets → exports **PNG/SVG**. Absolute positioning, layers, filters — the "make it beautiful" tool.
- **GrapesJS** = *document* builder → landing pages, email newsletters (MJML preset) → exports **responsive HTML/CSS**. DOM components, style manager, blocks — the "make it publishable" tool.
They share ~zero code paths and serve adjacent steps in the same workflow (design the hero in Canvas → drop it into a GrapesJS landing page). GrapesJS as an npm library is the cheapest integration in this batch (low–medium effort, BSD, zero runtime). Recommendation: **keep both**; Canvas owns creative assets, GrapesJS owns page/email assembly.

## Verdict 3: Payload vs Strapi — Payload, decisively.
| | Payload | Strapi |
|---|---|---|
| License | MIT, no carve-outs | Open-core: MIT CE + **proprietary EE** (RBAC, audit, SSO gated) |
| AGPL dual-license fit | Clean | CE/EE firewall required forever; EE features can't ship in the bundle |
| Stack fit | **Runs inside Marketr's Next.js app** (`@payloadcms/next`, Local API) | Separate Koa service, own DB, sidecar ops |
| Infra | Reuses existing PG 5433 | New DB + new service to deploy/monitor |
| Modeling | Code-first TS, git-versioned | Click-ops UI, JSON schemas |
| Ecosystem | Smaller | Larger plugins/community — but best pieces trend EE/paid |
**Payload wins on every axis that matters for an AGPL+commercial, agency-white-labeled, Next.js product.** Strapi's larger community doesn't compensate for a proprietary license carve-out sitting on top of the features agencies actually need (RBAC, audit logs). If Marketr needs a CMS layer, Payload is the pick; Strapi is a don't-bother.
