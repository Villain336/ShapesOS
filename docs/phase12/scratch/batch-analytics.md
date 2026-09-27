# Phase 12 research batch: analytics / replay / flags / data-pipeline / BI repos

Researched 2026-09-27. License facts verified from repo READMEs/docs quoted by search; repo URLs checked live. Anything not verifiable is marked UNVERIFIED. No guessing.

---

## 1. PostHog (PostHog/posthog)

- **Repo:** https://github.com/PostHog/posthog (32k+ stars as of March 2026)
- **License:** MIT expat for the core repo, EXCEPT the `ee/` directory which is under a separate PostHog Enterprise License (the README's "Open-source vs. paid" section states this verbatim; the `ee/LICENSE` file holds its terms). There is also `PostHog/posthog-foss`, a mirror purged of all proprietary code and features (pure MIT).
- **License notes/changes:** PostHog moved the enterprise surface OUT of MIT over time — the current model is MIT core + proprietary enterprise modules. It is NOT SSPL/Elastic/BSL. The `ee/` license is a commercial source-available-style license: per a third-party helm chart's README analysis, free for development and testing, production use only with a subscription (third-party reading; the exact `ee/LICENSE` text was not fetched — see caveat). The historical arc: earlier self-hosted versions shipped more under MIT; enterprise features have been steadily partitioned into `ee/` since ~2022–2023. What applies NOW: use posthog-foss or strip `ee/` for a clean MIT build; the official `posthog/posthog` Docker image bundles `ee/`.
- **AGPL-compat (AGPLv3 + commercial dual-license, agency white-label):** MIT core is one-way compatible with AGPLv3 — embedding MIT code in an AGPLv3 product is fine. Two catches: (1) any deployment must exclude `ee/` or you need a PostHog subscription; (2) the official docker image bundles `ee/`, so a white-label deploy must build from the foss tree (the mayflower/posthog-helm community chart exists precisely to ship a pure-MIT image build). No network-copyleft obligation from PostHog's own licenses.
- **Integration shape + cost:** Sidecar service + JS SDK (`posthog-js`, Next.js SDK) + REST API. DO NOT fork-and-modify the Django monolith for white-label — treat it as a separate deployable. Engineering cost: MEDIUM to wire (SDK + API + dashboards), but ops cost is HIGH (see footprint). Embed dashboards via its API or link out; iframe of the PostHog app is possible but hard to white-label (its UI is PostHog-branded).
- **Runtime footprint:** HEAVY. Django web monolith + Node plugin-server + Rust capture services + ClickHouse (analytics store) + Postgres + Redis + Kafka/Redpanda + Temporal + MinIO/SeaweedFS for replay blobs. Hobby deploy stack is ~25 services; upstream guidance: 8GB RAM minimum (deploy script warns "REALLY need 8GB+"), 16GB/4vCPU/30GB disk typical; boots in 5–10 min; ~100k events/month cap on self-host before upstream recommends Cloud. Cannot sidecar a Next.js app — it is its own service fleet.
- **Fit score: 4/5.** One platform replaces four integration tracks (analytics + rrweb-based session replay + feature flags + experiments + CDP + error tracking + surveys). Deducted one point purely for ops weight: an agency white-label deployment would be asking every agency to run a 25-service fleet, which fights Marketr's "ship fast, keep it light" posture. Perfect fit if Marketr ever needs experiments/flags/CDP natively; oversized if it just needs pageview dashboards.

---

## 2. rrweb (rrweb-io/rrweb)

- **Repo:** https://github.com/rrweb-io/rrweb (active — docs commits 3 days before research date)
- **License:** MIT ("Copyright (c) 2018 rrweb", reproduced verbatim in third-party THIRD-PARTY-NOTICES files). No SSPL/Elastic/BSL traps anywhere. Note: there are vendor forks (New Relic fork under Apache for its changes; browser-replay fork under MIT); the canonical upstream is MIT.
- **License notes/changes:** None found — MIT since 2018, no relicensing history.
- **AGPL-compat:** MIT is fully compatible with AGPLv3 + commercial dual-license. Zero network-copyleft risk; the npm packages (`@rrweb/record`, `@rrweb/replay`, `rrweb-player`) can be vendored, modified, and rebranded freely.
- **Integration shape + cost:** Embed as npm library — the lightest possible shape. `record()` captures DOM mutations, `Replayer` plays them back; own the storage layer (events are JSON). Engineering cost: LOW for capture+playback (~1–2 days for a basic viewer), MEDIUM if you build masking/compression/redaction for client privacy. Can be lazily loaded so it's off the hot path.
- **Runtime footprint:** Negligible — client-side JS library, no server components, no DB. Events are data you store wherever you already store things (Postgres/S3).
- **Fit score: 5/5 as a standalone library** — but only if PostHog is NOT adopted (PostHog's bundled replay is rrweb-lineage, making a separate integration redundant). As a surgical capability ("see exactly what a visitor did before bouncing off a client's campaign page"), rrweb is the cheapest session-replay capability in the batch by an order of magnitude. Caveat: large-DOM recordings can block the main thread during serialization (documented upstream issue) — needs sampling/throttling for heavy editor pages.

---

## 3. Umami (umami-software/umami)

- **Repo:** https://github.com/umami-software/umami (badge on README: MIT License; multiple independent sources confirm)
- **License:** MIT. No license changes found; no enterprise/proprietary partition, no source-available traps.
- **License notes/changes:** None — MIT since inception. Umami Cloud is the paid SaaS of the same MIT codebase.
- **AGPL-compat:** MIT is fully compatible with AGPLv3 + commercial dual-license. No network-copyleft, no embedding restrictions. White-labeling the dashboard is license-clean (keep the copyright notice).
- **Integration shape + cost:** Sidecar Next.js app (or link/API-only). Two shapes: (a) deploy one Umami instance per agency (multi-site dashboard built in), iframe or link dashboards into Marketr; (b) hit its API (`/api/send`, stats endpoints) and render your own UI — LOW–MEDIUM cost since it's Next.js + Prisma, the same stack as Marketr, so a fork-and-reskin is genuinely feasible.
- **Runtime footprint:** LIGHT. Node.js 18.18+ + Postgres (also supports MySQL/MariaDB); ~100MB idle RAM; a single docker-compose service + DB. Can sit beside a Next.js app as a tiny sidecar.
- **Fit score: 4/5.** The cheapest credible analytics for agency white-label: cookieless/privacy-first (no consent-banner fights for agency clients), multi-site from one dashboard, Next.js-native. What it lacks vs PostHog: no session replay, no feature flags, no experiments, shallower product analytics. Perfectly sufficient for "how is the client's site/campaign performing" dashboards.

---

## 4. GrowthBook (growthbook/growthbook)

- **Repo:** https://github.com/growthbook/growthbook (~8k stars Aug 2026; v5.0.0 released July 2026)
- **License:** Open Core. The bulk of the monorepo is MIT; several `enterprise/` directories are under the separate GrowthBook Enterprise License (commercial, source-available — README states this verbatim). All language SDKs are MIT. No SSPL/Elastic/BSL.
- **License notes/changes:** The Enterprise partition dates to a 2023 PR ("Move Enterprise code to separate package"); since then more features moved into enterprise dirs (SSO, feature encryption, scheduled rollouts, advanced stats like CUPED/sequential). Current v5 added governance tools + Product Analytics GA (2026). Nothing in 2026 relicensed the MIT core.
- **AGPL-compat:** MIT core is AGPLv3-compatible; the Enterprise modules are proprietary — a white-label build must exclude `enterprise/` dirs (they gate on a paid license key). No network-copyleft in the MIT portion. Watch the boundary: features you may want (SSO, encryption, scheduling) live on the proprietary side.
- **Integration shape + cost:** Sidecar Docker image (NextJS front-end + ExpressJS API + Python stats engine bundled in one image) + MongoDB + SDKs in client apps. API/SDK-only integration — flags are evaluated from a downloaded feature definition, SDKs keep working cached through outages. Engineering cost: LOW for SDK gating of Marketr features; MEDIUM if using experiments against a warehouse (needs data-source wiring).
- **Runtime footprint:** MODERATE. One app container + MongoDB; Python stats engine in-process. Far lighter than PostHog. Not sidecar-in-Next.js but a small two-service deploy.
- **Fit score: 3/5.** Best-in-class open experiments (CUPED/sequential stats, warehouse-native) — genuinely useful for an agentic marketing ecosystem that A/B-tests campaigns and landing pages. But feature-flag infrastructure is not load-bearing for "the editor that keeps clients on-brand" today; it becomes valuable the day Marketr runs growth experiments as a product feature, not before.

---

## 5. Unleash (Unleash/unleash)

- **Repo:** https://github.com/Unleash/unleash (~13.8k stars Aug 2026; $35M Series B March 2026)
- **License:** **AGPLv3 as of v8.0.0 (2026)** — FLAG. Upstream moved the primary repo and the `unleash-server` npm package from Apache 2.0 to AGPLv3; announced in the official v8 changelog ("Evolving our open source commitment"). Official open-source Docker images remain Apache 2.0 (running the prebuilt image unmodified is unaffected); all client SDKs keep permissive licenses; Enterprise/Cloud unaffected.
- **License notes/changes:** This is the single most important license event in the batch — it happened in 2026 and exactly the "source-available trap" class this research was told to flag. It is NOT SSPL (AGPLv3 is a real OSI/FSF license), but it IS network-copyleft.
- **AGPL-compat:** AGPLv3 source is license-compatible with an AGPLv3 product — no GPL-incompatibility issue. BUT the business implication for agency white-label is real: if Marketr forks or modifies Unleash's source and offers it to clients over the network (white-label = network distribution), AGPLv3 requires publishing the modified source under AGPLv3 — acceptable only if the dual-license strategy accounts for it; clients expecting proprietary white-label binaries would force a commercial Unleash license. Running the unmodified Apache-2.0 Docker image sidesteps the source change but forfeits any white-label reskin. Net: the license allows use, but it taxes exactly the fork-and-modify white-label pattern Marketr would want.
- **Integration shape + cost:** Sidecar server + Postgres + SDKs (React/Next.js SDKs exist). Flags-first product — no native experimentation (that analysis lives elsewhere). Engineering cost: LOW for flags; but the AGPL boundary makes fork-and-reskin legally fiddly.
- **Runtime footprint:** MODERATE. TypeScript server + Postgres; admin UI included. Comparable to GrowthBook, lighter than PostHog.
- **Fit score: 2/5.** A solid flags server whose 2026 AGPL move lands squarely on the wrong side of Marketr's white-label economics, and it brings no experimentation to justify the friction. GrowthBook dominates it for this use case (MIT core + native experiments). Only pick Unleash if flag infrastructure alone is needed AND you run the unmodified image.

---

## 6. Jitsu (jitsucom/jitsu)

- **Repo:** https://github.com/jitsucom/jitsu (current branch `newjitsu` = Jitsu 2.0; the old 1.x lives on the `master`/"classic" branch)
- **License:** MIT (README links the MIT license; independent sources confirm). No license changes found; no SSPL/Elastic/BSL.
- **License notes/changes:** None — MIT across both the Classic and 2.0 lines.
- **AGPL-compat:** MIT is fully compatible with AGPLv3 + commercial dual-license; no network-copyleft, no embedding restrictions.
- **Integration shape + cost:** Sidecar data-pipeline service + JS SDK / HTTP API / drop-in Segment proxy. Event collection from browser/mobile/server → delivery to warehouses (ClickHouse, BigQuery, Snowflake, Postgres, S3...) with JS "Functions" for transform/enrich and an identity graph. Engineering cost: LOW to start collecting events; MEDIUM–HIGH for a full multi-destination pipeline with functions and connector syncs (upstream docs: feature-complete self-hosting since 2.14 effectively wants Kubernetes for the operator, function servers, and connector sync jobs).
- **Runtime footprint:** MODERATE–HEAVY. Helm chart dependencies: Postgres, Kafka, MongoDB, ClickHouse. Implementation language of the 2.0 console: UNVERIFIED from the sources fetched (image `jitsucom/console`). Compose-based core deploys exist; full feature set wants K8s. Not a Next.js sidecar — separate service stack.
- **Fit score: 3/5.** MIT Segment-alternative is attractive for a marketing OS that will eventually want first-party event collection piped into client warehouses. But it is infrastructure ahead of need: Marketr's data strategy is BYO keys + agency-owned data, and a CDP only pays off once there are destinations to feed. Keep on the radar; don't adopt in Phase 12.

---

## 7. Apache Superset (apache/superset)

- **Repo:** https://github.com/apache/superset (stable 6.1.0 released 2026-05-13; ~73k stars)
- **License:** Apache License 2.0. ASF top-level project since 2021 — no relicensing risk, no enterprise partition, no source-available traps.
- **License notes/changes:** None — Apache-2.0 for the life of the project. Preset (the founder's company) monetizes managed hosting, which keeps the OSS license stable.
- **AGPL-compat:** Apache-2.0 is compatible with AGPLv3 for combined works (one-way). Embedding/modifying for white-label is license-clean; trademark "Apache Superset" must be respected in branding, not in the license.
- **Integration shape + cost:** Sidecar BI service + embed via guest-token iframe or build dashboards against its REST API. RBAC + row-level security make it genuinely multi-tenant (one Superset, per-client data scoping). Engineering cost: MEDIUM to deploy and wire data sources; LOW to embed existing dashboards via guest tokens. 2026 versions added MCP tools and an extension framework (superset-core), which could matter for the agentic layer later.
- **Runtime footprint:** MODERATE. Python/Flask (Gunicorn) + Postgres metadata DB + Redis (cache + Celery broker) + Celery workers/beat. ~4–6 containers; lighter than PostHog, heavier than Umami.
- **Fit score: 3/5.** The right answer for "agency needs client-facing reporting dashboards with real SQL depth" — but dashboards are a support act, not the mission. Marketr's differentiator is the agentic editor, not BI. Adopt when agency reporting becomes a revenue line, not before.

---

## Strategic verdicts

### Verdict 1: Does PostHog make GrowthBook/Unleash AND a separate rrweb integration redundant?

**Mostly yes, with an ops-cost asterisk.** Verified: PostHog bundles product analytics, web analytics, session replay (rrweb-lineage — PostHog maintained the `@posthog/rrweb` fork, and as of 2026 it is inlined into `posthog-js` at `posthog-js@1.376.0`), feature flags (Rust `/decide` service), experiments, plus error tracking, surveys, and a CDP — all in one MIT-core platform. One PostHog deploy genuinely covers the jobs of GrowthBook (flags + experiments), Unleash (flags), and a standalone rrweb integration (replay). **However:** (a) the self-hosted stack is ~25 services needing 8–16GB RAM with a ~100k events/mo ceiling before upstream steers you to Cloud — per-agency white-label deploys of this are heavy; (b) white-label needs the foss tree (official image bundles proprietary `ee/`); (c) experiments in PostHog are good, GrowthBook's stats engine (CUPED/sequential, warehouse-native) is deeper. So: redundant as capability coverage, not redundant as an ops decision — if Marketr wants flags/experiments/replay without a 25-service fleet, GrowthBook's one-container + MongoDB or a surgical rrweb embed remain the lighter answers.

### Verdict 2: PostHog vs Umami — pick ONE

**Pick Umami.** For Marketr's actual mission — an agentic marketing editor white-labeled by agencies — the deciding factors are white-label economics and stack fit, not feature breadth. Umami is MIT with no enterprise partition (no `ee/` trap to navigate), Next.js + Postgres (same stack family as Marketr — a fork-and-reskin is genuinely feasible), ~100MB idle vs PostHog's 8–16GB fleet, cookieless by design (no consent-banner friction for agency clients), and multi-site from one dashboard. The capabilities PostHog adds — session replay, feature flags, experiments, CDP — are real but none are load-bearing for a marketing editor today, and each can be added later at a fraction of the cost (rrweb embed for replay, GrowthBook for experiments when A/B testing becomes a product feature). PostHog is the right answer the day Marketr needs experiments/flags/CDP natively; until then it is a 25-service answer to a one-service question.

---

*Sources: repo READMEs and docs quoted via web search 2026-09-27 — PostHog README ("Open-source vs. paid"), mayflower/posthog-helm README (ee/ licensing analysis), rrweb-io/rrweb docs + third-party THIRD-PARTY-NOTICES (MIT text), GrowthBook README + docs/self-host.mdx (Open Core + MongoDB), Unleash v8 changelog (AGPLv3 announcement), Jitsu README + stafftastic/jitsu-chart (MIT + dependencies), apache/superset READMEs + Wikipedia (Apache-2.0, 6.1.0). One caveat: the PostHog `ee/` production-use terms were read via a third-party chart's summary, not the `ee/LICENSE` file itself.*
