# Phase 12 marketing-ops repo research — batch 1 (verified 2026-09-27)

Sources: upstream GitHub READMEs / LICENSE files (crawled Sept 2026) via search; upstream commits where cited.
Rule used: facts marked UNVERIFIED where the source didn't confirm them. No memory-only claims.

---

## Twenty

- **Repo:** `https://github.com/twentyhq/twenty` — "The #1 Open-Source CRM" (~55k stars as of Aug 2026)
- **License:** **AGPLv3 core** + Section 7 **"Twenty Application Exception"** appended to the LICENSE file (verified from upstream commit `a9d996f` "Clarify application licensing and add trademark policy", twentyhq/twenty). The Oct 2024 "more commercial-friendly license" blog framing was interpretive press, NOT a license change — the actual LICENSE remains AGPLv3.
- **License notes/changes:** Three-tier structure: (1) AGPLv3 core with the Application Exception — apps interacting with Twenty through its published Application Interfaces (REST/GraphQL APIs, webhooks, app manifests, function runtime, component renderer, published SDKs) do NOT become AGPL-governed; apps built with the SDK can be proprietary. (2) Files tagged `/* @license Enterprise */` fall under the proprietary **Twenty.com Commercial License** (SSO/SAML, row-level permissions, audit logs, encryption key rotation, single-tenant isolation, SCIM, IP allow-listing) and are runtime-gated by `ENTERPRISE_KEY` + `ENTERPRISE_VALIDITY_TOKEN`. (3) SDK packages (`twenty-sdk`, `twenty-client-sdk`, `create-twenty-app`, `twenty-shared`, `twenty-ui`, `packages/twenty-apps`) are **MIT**. A CLA exists; trademark policy was added in the same commit. v2.0 (Apr 2026) added AI SDK, native MCP server, git-backed workspace versioning; v2.1 (Apr 24 2026) is the first release the team marks production-ready for single-tenant self-host.
- **AGPL-compat:** Same family as Marketr (AGPLv3). Clean. The Application Exception is actually a useful pattern to study.
- **Integration shape + cost:** **API/SDK-only; don't fork.** Forking means inheriting a 4-service platform plus enterprise-gated code and CLA/trademark friction. The honest use is: talk to it over REST/GraphQL/webhooks, or build apps on its MIT SDK. Cost: medium — learning its metadata model and wiring sync.
- **Runtime footprint:** TypeScript (NestJS) + React; **PostgreSQL 15 + pg_graphql**, **Redis**, BullMQ workers. ~750 MB idle; 1–2 GB + 2 vCPU for small-team prod. Needs its own services — cannot sidecar inside a Next.js app.
- **Fit score: 2/5.** Quality platform, wrong weight class for Marketr. The mission is "the editor that keeps clients on-brand" + agentic marketing ecosystem, not Salesforce. (See verdict 1 below.)

---

## Listmonk

- **Repo:** `https://github.com/knadh/listmonk` (~23.4k stars)
- **License:** **AGPL-3.0** (README + LICENSE, unchanged since 2019). No enterprise carve-out, no recent change found.
- **License notes/changes:** None — clean single AGPLv3 grant. The standard AGPL network-use clause applies: modify + offer as a service to third parties → publish modifications. Self-hosting for own use is unaffected.
- **AGPL-compat:** Perfect — same license family as Marketr's AGPLv3 leg.
- **Integration shape + cost:** **Sidecar + REST API; don't fork.** It exposes a full REST API (subscriber/list management, campaign creation/scheduling, templates, analytics) plus a transactional-mail API. Effort: low — deploy the binary, call the API, never touch its code.
- **Runtime footprint:** **Single Go binary** + PostgreSQL. Tiny. The ideal sidecar next to a Next.js app. Handles millions of subscribers; multi-SMTP round-robin, throttled sending, bounce/click/open tracking, public subscription pages.
- **Fit score: 5/5.** The obvious email engine for a self-hosted marketing SaaS: featherweight, AGPL-clean, API-first. (See verdict 2.)

---

## Mautic

- **Repo:** `https://github.com/mautic/mautic` (~7k stars); UN Digital Public Good verified (2024)
- **License:** **GPL-3.0-or-later.** No recent change found; marketplace policy treats it as viral — plugins "should be GPLv3" per its own docs.
- **License notes/changes:** None recent. Straight GPL copyleft, no AGPL network clause (its SaaS exposure surface is weaker than AGPL's, which is why its commercial ecosystem exists).
- **AGPL-compat:** Workable under Marketr's dual-license posture (AGPLv3 + commercial), but GPL-3.0 code linked into the product drags copyleft with it — keep it across an API boundary and there's no issue.
- **Integration shape + cost:** **API/webhooks-only; do NOT fork or embed.** Cost: high if embedded (PHP runtime next to Next.js, Symfony app, cron-job-driven queue architecture — segments, campaigns, and sends all run on cron). As an API integration: medium (learn its REST API + webhook model).
- **Runtime footprint:** PHP/Symfony + MySQL + cron workers. Heavy operationally relative to its feature surface; needs its own service and cron discipline. Cannot sidecar into Next.js.
- **Fit score: 2/5.** Full marketing-automation depth (lead scoring, drip campaigns, landing pages, forms) but the PHP+MySQL+cron ops burden is the wrong shape for a Next.js SaaS, and Listmonk covers 80% of the email need at 5% of the ops cost. (See verdict 2.)

---

## Activepieces

- **Repo:** `https://github.com/activepieces/activepieces` (~24.3k stars)
- **License:** **MIT** for the Community Edition (LICENSE at repo root); code under `packages/ee/` under a separate **Commercial License** (enterprise features: SSO, audit logs, etc.). Verified from the README's license section.
- **License notes/changes:** No SSPL/Elastic/BSL traps. MIT core is genuinely permissive; just don't assume `packages/ee/` is MIT.
- **AGPL-compat:** Excellent — MIT is one-way compatible into AGPLv3 products with zero copyleft burden on Marketr's side.
- **Integration shape + cost:** **Fork pieces or consume via API/MCP — this is the one repo worth forking from.** Every one of the 280+ integration "pieces" is a TypeScript npm package, and pieces are also published as MCP tools — directly consumable by Marketr's agent layer (Chief Strategy Agent / missions). Cost: medium — learn the pieces SDK; forking a piece is small, running the full engine is a compose stack.
- **Runtime footprint:** TypeScript; Docker Compose (Postgres + Redis + app + worker). Medium. Own services; pieces themselves are portable npm packages that could be embedded.
- **Fit score: 4/5.** The automation backbone Marketr's missions/playbooks could ride on, with the only truly permissive license in this batch and an MCP-native integration catalog. Highest fork value of the eight.

---

## Postiz

- **Repo:** `https://github.com/gitroomhq/postiz-app` (~31.6k stars, active — pushed June 2026)
- **License:** **AGPL-3.0** + commercial license available from Gitroom. No SSPL/BSL traps; no recent license change found.
- **License notes/changes:** Standard AGPL-3.0. Real-world precedent for AGPL-compliant commercial use exists: **Postra** (`postra-app/postra-app`, a UK/PL agency SaaS) is built on Postiz and publishes its modified source — the model works. Heads-up: the community `@postiz/node` SDK is AGPL-3.0, so do NOT link it into Marketr's codebase — one downstream project enforces a structural "license firewall" test (no `postiz` in any package.json deps section) and uses raw fetch instead. Copy that pattern.
- **AGPL-compat:** Same family as Marketr. Clean; commercial license available from Gitroom if white-label needs it.
- **Integration shape + cost:** **Sidecar + Public API / built-in MCP; don't fork.** Postiz ships a bundled MCP server (`libraries/mcp`, Settings → Public API → copy MCP URL) — the most agentic-native integration surface in this batch. The real cost is operational, not engineering: ~30 channels (X, LinkedIn personal+company, FB, IG, YouTube, Threads, Bluesky, TikTok, Pinterest, Reddit, Mastodon, Discord, Slack…), each needing its own OAuth app, token-refresh babysitting, and a TLS domain for OAuth redirects.
- **Runtime footprint:** Next.js frontend + NestJS backend, Prisma/PostgreSQL, **Redis + BullMQ**, and **Temporal from v2.12+** (added dependency — budget for it). Medium-heavy; its own stack, not embeddable in Marketr's Next.js app.
- **Fit score: 4/5.** The social-publishing layer for an agentic marketing ecosystem: one OAuth dance per channel instead of thirty, MCP-native, agentic-first positioning matches Marketr's direction. (See verdict 3.)

---

## Dub

- **Repo:** `https://github.com/dubinc/dub` — "the modern link attribution platform" (short links, conversion tracking, affiliate programs)
- **License:** **Open core: 99% AGPLv3 + 1% commercial** ("/ee" Enterprise Edition). Verified verbatim from the upstream README (crawled Sept 2026): *"the core technology (99%) is fully open source, licensed under AGPLv3 and the last 1% is covered under a commercial license ('/ee' Enterprise Edition)"*.
- **License notes/changes:** No recent license change found — the open-core structure is the standing position. **The scrutiny (flagged in the brief) is structural, not a new event:** the commercially valuable surface is exactly what's behind the commercial line. Dub Partners (the affiliate program product) requires paid cloud plans — Business $90/mo with partner payouts capped at $2,500/mo at a 5% payout fee; Advanced $300/mo, $15k cap, 5%; Enterprise custom, 3% (pricing as of July 2026, and rising: Business went $75→$90 between June–July 2026). **Whether the Partners/affiliate code ships in the AGPL repo or lives only in /ee / cloud: UNVERIFIED** — could not confirm from sources checked. That is the red flag: you cannot assume the affiliate features are self-hostable under AGPL.
- **AGPL-compat:** The AGPLv3 core is compatible with Marketr's AGPLv3 leg; the /ee commercial code is NOT usable without a Dub commercial license, and its boundary is exactly where Marketr's interest lies (affiliate).
- **Integration shape + cost:** **API-first; self-host core for links only after verifying the /ee boundary.** Do not fork assuming affiliate features come along. Cost: low for link-shortening via API; the affiliate layer would need Dub cloud (paid, with payout-fee toll) or a separate build.
- **Runtime footprint:** Next.js monorepo (pnpm workspaces, apps/web). Self-hostable via Docker. Exact DB/queue backend: UNVERIFIED from sources checked. Medium; own service.
- **Fit score: 3/5.** Best-in-class link infra, SDKs in five languages, signup-anchored attribution — but the open-core boundary sits exactly on the affiliate features Marketr would want, and the Partners toll structure (subscription + 5% of every payout) is hostile to agency margins. (See verdict 3.)

---

## Chatwoot

- **Repo:** `https://github.com/chatwoot/chatwoot` (~20k+ stars) — "© 2017-2026, Chatwoot Inc — Released under the MIT License."
- **License:** **MIT core**; *"Portions under `enterprise/` are licensed separately — see LICENSE and enterprise/LICENSE."* Verified from upstream README.
- **License notes/changes:** None recent. The Community Edition Docker image (`-ce` tag) omits the separately-licensed enterprise code (SSO/SAML, audit logs, agent capacity, custom branding, SLA policies, Captain AI) — no key or activation needed, absent by design.
- **AGPL-compat:** Ideal — MIT is permissive; no copyleft flows into Marketr.
- **Integration shape + cost:** **Embed widget via script/iframe or API; don't fork.** The live-chat widget is the integration surface; the Rails backend is a separate service. Cost: low (drop-in widget + API for conversations).
- **Runtime footprint:** Ruby on Rails + Sidekiq (+ Postgres/Redis per standard deploy). Medium; own service via Docker. Cannot sidecar into Next.js.
- **Fit score: 3/5.** License-ideal and trivially embeddable, but a support inbox is adjacent to — not inside — Marketr's mission ("the editor that keeps clients on-brand"). Useful later for agency client support; not a Phase-12 priority.

---

## Formbricks

- **Repo:** `https://github.com/formbricks/formbricks` — open-source Qualtrics alternative
- **License:** **AGPLv3 core**; Enterprise Edition code in `apps/web/modules/ee` under a separate **Enterprise license** (needs a license key; EE code ships in the Docker images but is locked).
- **License notes/changes:** None recent — but the README carries an explicit policy that is a hard blocker (verified across the upstream README and multiple forks, current as of Sept 2026): **"We currently do not offer Formbricks white-labeled. That means that we don't sell a license which lets other companies resell Formbricks to third parties under their name nor take parts (like the survey editor) out of Formbricks to add to their own software products."**
- **AGPL-compat:** The AGPLv3 core is license-compatible with Marketr, but the vendor's stated white-label policy directly conflicts with Marketr's agency white-label model. AGPL gives the legal right to fork/modify, but the commercial relationship (and the EE features) would be adversarial — and extracting the survey editor into Marketr's product is exactly what they say they won't license.
- **Integration shape + cost:** **Link-survey integration only (embed survey links); do NOT extract the editor.** Cost: low for link surveys; blocked for deep integration.
- **Runtime footprint:** Next.js + Postgres. Medium; own service.
- **Fit score: 2/5.** Good product, wrong commercial posture for Marketr. The explicit no-white-label / no-editor-extraction policy kills the strategic fit even though the license family matches.

---

## Strategic verdicts

### 1. Twenty — redundant or worth forking?

**Redundant for now; do not fork.** Marketr already has CRM modules and Tico has a separate React CRM artifact — the contact/company/deal tracking need is covered. What Twenty uniquely adds is a metadata-driven custom-object platform, GraphQL/REST, native MCP, workflow automation, and email sync — i.e., a Salesforce-class system, not a marketing tool. That power comes as a 4-service heavyweight (NestJS, Postgres+pg_graphql, Redis, BullMQ workers) with enterprise features (SSO, audit logs, row-level permissions) locked behind a commercial license + runtime key, plus CLA/trademark friction on any fork-and-rebrand. For Marketr's mission it solves a problem Marketr doesn't have yet. If CRM depth ever becomes load-bearing, integrate over its API (the MIT SDK + Application Exception make that clean) — never fork. One thing worth stealing is the *pattern*: AGPLv3 core + Section 7 application exception + MIT SDKs is a proven template for Marketr's own ecosystem licensing.

### 2. Listmonk vs Mautic — pick one

**Listmonk, decisively.** For a self-hosted Next.js SaaS the comparison isn't close: Listmonk is a single Go binary + Postgres with a clean REST API (campaigns + transactional mail), AGPL-3.0 (same family as Marketr), near-zero ops burden. Mautic is a PHP/Symfony + MySQL app driven by cron jobs — full marketing-automation depth (lead scoring, drip campaigns, landing pages) at the price of a second runtime, a second database technology, and cron discipline next to a Node stack. Mautic's extra features (scoring, drip logic) are better rebuilt as thin Marketr-native logic on top of Listmonk's send engine than inherited as a PHP monolith. Integration: run Listmonk as a sidecar, talk to it over its API, never fork it.

### 3. Postiz vs Dub — Dub license red flags?

**Postiz is the cleaner bet; Dub carries two real flags.** (a) The money features sit behind the commercial line: Dub Partners (affiliate programs) is a paid-cloud product ($90/mo + 5% of every partner payout on Business, rising prices through 2026), and whether the affiliate code is even present in the AGPL repo (vs /ee-only or cloud-only) is UNVERIFIED — you cannot plan a self-hosted affiliate layer on Dub without resolving that. (b) The 99%/1% open-core framing means the commercially valuable 1% is precisely what an agency product would want to white-label. Postiz, by contrast, is full AGPL-3.0 with a commercial license available from Gitroom, ships a built-in MCP server (agentic-native, matches Marketr's direction), and has a proven AGPL-compliant agency-SaaS precedent (Postra publishes its modified source). Recommendation: Postiz as the social-publishing sidecar (API/MCP, raw fetch — never link the AGPL `@postiz/node` SDK; copy the license-firewall pattern); Dub only for link shortening via its API or self-hosted core *after* verifying the /ee boundary — and budget for Dub cloud or a separate affiliate build if partner payouts matter.
