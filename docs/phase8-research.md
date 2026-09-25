# Marketr Phase 8 — Research Brief: The Agentic Substrate

**Date:** 2026-09-25. All sources 2026-current, dated inline. No vendor was contacted.
**Deep memos:** two parallel research subagents (knowledge graphs + campaign objects; agent memory + sync honesty), full memos in the parent agent's context.

**Locked decisions from the user (do not re-litigate):**
1. Open-core vs. commercial split is DEFERRED — mapped in Phase 7, still untouched.
2. §3.1 autopilot money rules are structural invariants — nothing in Phase 8 grants spending authority. The graph and memory are read/compute substrate; the Campaign object orchestrates but every execution still passes through existing approval objects (Phase 5 per-buy, F1 SRA).
3. Phase 8 is research + spec first. No code until Tico approves the spec.

**Environment finding (verified on-disk 2026-09-25):** the Postgres bundled with the preview environment ships `pgvector` (`vector.so` + `vector.control` present — needs `CREATE EXTENSION vector`). Apache AGE is absent; Neo4j/Kùzu are non-options (Kùzu was abandoned Oct 2025, archived — see below).

---

## Track 1 — Business knowledge graphs for marketing/agency use (2026)

**Headline: the 2026 driver of per-client KGs is GraphRAG grounding for agents, not classic SEO graphs.** The practitioner pattern (Neo4j/Memgraph marketing; umwelten project report 2026-04-21): LLM-based NER/relation extraction over CRM records, tickets, web content, ad/keyword data → canonical node tables + relationship tables → hybrid vector+graph retrieval. Per-client = per-tenant graph, isolated at DB or schema level. Typical entity types (synthesized, no canonical list exists): Contact/Person, Company, Product, Price, Location, Review, Campaign, Creative/Ad, Keyword, Channel, Segment/Audience, Asset (landing page, form, CTA, email).

### Entity resolution — solid practitioner consensus
- Pipeline: **blocking → matching → clustering**, incremental not batch ("entity resolution is continuous; build for incremental updates" — A. Shereshevsky, Medium, Jan 2026).
- Cascading matchers: deterministic rules → ML → LLM as a cost/accuracy ladder; embeddings (FAISS) increasingly used for blocking; graph community-detection (Louvain) preferred over naive transitive closure to avoid over-merging.
- Scale-to-tool mapping: <1M entities → `dedupe` (MIT); 1–100M → **Zingg** (AGPL, Spark-native, active learning) or **Splink** (MIT, Fellegi–Sunter, DuckDB/Spark/Athena); 100M+ → graph-native methods. Commercial: AWS Entity Resolution, LiveRamp/ID5 for identity.
- Provenance pattern: canonical `Entity` node + `SAME_AS` edges back to `SourceRecord` nodes — merges auditable and reversible.
- Graph-native disambiguation: identifiers (email, phone, device) as shared nodes; connected components / node-similarity reveal duplicates invisible to pairwise SQL.

### Update cadences — the honest taxonomy
- **Real-time (<1s):** only via CDC streaming (Debezium reading PG WAL → Kafka) or platform webhooks. AllegroGraph documents Kafka/Debezium streaming into a master RDF KG — but **batches the actual graph writes overnight**, logging daytime changes to a staging table. Honest pattern: **stream ingest, scheduled apply**.
- **Freshness tiers** (decube.io, Sept 2026 — vendor, but taxonomy matches practice): real-time = fraud/pricing; near-real-time = ops dashboards; **hourly = campaign reporting, sales pipeline views**; daily = exec/finance; weekly+ = reference data. For agency marketing workloads, **hourly–daily is the defensible tier**; anything promising "real-time KG" is streaming *events*, not the *resolved graph*.
- **What breaks freshness:** API deprecations and rate limits; schema migrations silently corrupting consumers; polling-based syncs missing deletes. Eventual consistency must be designed in. (Reddit's public API winds down 2026-09-30 — relevant to any review/social ingestion.)

### Postgres-native vs dedicated graph stores — the 2026 verdict at agency scale
- **Postgres wins until proven otherwise.** UW benchmark: Postgres outperformed Neo4j on nearly every query; Neo4j's edge appeared only at >5-table joins on large datasets. Postgres also won on ingestion ease, disk footprint (Neo4j ~10× raw size in that study), and constrained-memory behavior. (Older study, Neo4j unindexed — directional, not a 2026 verdict.)
- **Practitioner rule of thumb:** stay in Postgres (recursive CTEs, JSONB properties, `ltree` for hierarchies, `pg_trgm`) while traversals are shallow (≤3–5 hops) and entity counts are in the low millions — which describes per-client agency KGs. Add `pgvector` for hybrid vector+graph retrieval instead of a second store.
- **Tenant isolation:** Postgres = `tenant_id` + RLS or schema-per-tenant (standard, cheap). Graph DBs need per-tenant databases/graphs or label-based filtering — coarser, more operational work.
- **Do NOT adopt KuzuDB:** Kùzu Inc abandoned the project Oct 2025, GitHub archived (The Register, Oct 2025); community fork "bighorn" maturity unverified; Apple quietly acquired Kuzu per an EU DMA filing (Feb 2026). The embedded-graph niche is in flux — avoid.
- **Apache AGE:** only dated (~2023) community tutorials; no 2026 production evidence — treat as unverified. (Also absent from our Postgres installs.)

### Event-sourced / append-only fact logs
No marketing-KG vendor does full event-sourced KGs — it's an infrastructure pattern, not a product category. Practitioner guidance converges: **append-only fact table + projected current-state view gets "80% of the benefit at 20% of the cost"** of full event sourcing. Full event sourcing costs: eventual consistency on reads, replay hazards (non-idempotent consumers re-firing side effects — documented Stripe double-charge incident), permanent event-versioning tax. It earns its keep only where audit/temporal queries are load-bearing. AllegroGraph's change-history-per-object is the closest KG-native analog. **Pragmatic 2026 pattern: append-only `facts` log in Postgres + materialized graph projection.**

---

## Track 2 — Cross-channel campaign objects (2026)

**Headline: no true first-class cross-channel campaign object exists anywhere in 2026.** HubSpot comes closest as an *association/reporting* layer; everywhere else it's loose association of channel-specific objects.

### How the platforms model "campaign" (verified)
- **HubSpot — closest to a true cross-channel object.** A Campaign is a **container for assets** (emails, landing pages, forms, CTAs, blog posts, social posts, ads) around one initiative, with roll-up reporting and **parent-child hierarchies up to 3 levels**. API: date-versioned Campaigns endpoints + `/marketing/v3/marketing-events`; 2026 additions: omni-channel tracking (calls, meetings, logged emails as touchpoints) and **Automated Ad Association** — linking ad groups/sets to campaigns **by naming convention**. Key semantic: HubSpot campaign tracks **assets and their performance**, *not* people.
- **Salesforce — the mirror image.** The Sales Cloud Campaign object tracks **people and path to revenue**: Campaign Members, member statuses, parent-child hierarchies, budget/expected revenue. In Marketing Cloud, "campaign" colloquially = Email Studio sends; cross-channel orchestration lives in **Journey Builder**. Next-gen (2025–26): Marketing Cloud Growth/Advanced on Data Cloud with **Agentforce Campaigns**. Practitioner warning: forcing HubSpot and Salesforce campaigns to mean the same thing "ends in frustration and messy reporting" — complementary, not equivalent.
- **GoHighLevel — no campaign object at all.** Legacy "Campaigns" deprecated in favor of **Workflows**; a "campaign" = an automation sequence (email/SMS/voicemail/appointment). No cross-channel roll-up ROI modeled.
- **Klaviyo — campaign = one-time send, email/SMS only.** Flows = triggered automations. No ads/social/landing-page linkage.

### Ad-platform structural mismatches (2026 practitioner playbooks)
| | Meta | Google Ads | TikTok |
|---|---|---|---|
| Hierarchy | Campaign → **Ad Set** → Ad | Campaign → **Ad Group** → Ad/Asset | Campaign → **Ad Group** → Ad |
| Budget level | Campaign (CBO/Advantage+, now default) or ad set (ABO) | Campaign (daily; shared budgets possible) | Campaign or ad group |
| Objective | Fixed at campaign, immutable | Varies by campaign type | Fixed at campaign |
| Learning gate | ~50 conversions/ad set/week | Varies; eCPC deprecated Mar 2025 | Daily minimums per ad group |

Mismatches when unifying under one ID: ad set vs ad group naming; budget semantics (campaign-level CBO vs group-level); status enums differ per platform; objective taxonomies differ; **Performance Max flattens ad groups into asset groups**, breaking the 3-tier assumption; budgets in minor currency units on Meta; attribution windows and naming conventions are per-account freeform. The industry's pragmatic unification hack is **naming-convention-based association** (HubSpot's Automated Ad Association; `utm_campaign={{campaign.name}}`). 2026 practitioner consensus: consolidate to 3–5 campaigns per ad account. New channel watch: **ChatGPT Ads integrated into HubSpot** (Sept 2026) — the channel list is still growing.

### Any 2026 standard for a unified campaign object? **No.**
- **AdCP (Ad Context Protocol) v3.0** (Apr 2026, Apache-2.0, built on MCP): full ad lifecycle — discovery, media buys, creative production (brand.json), governance, reporting across 20 channels; in production at Snap, Pinterest, Reddit, Netflix, Vox Media. Scope is **buy-side/programmatic orchestration**, not CRM/email/social campaign modeling — useful vocabulary, not a schema to adopt.
- **IAB Tech Lab AAMP** (v2.0 June 2026): transaction rails (OpenRTB/AdCOM/OpenDirect/VAST + MCP/A2A) — deals and auctions, not campaign objects.
- Community/OSS: `acnet-ai/marketing-spec-kit` (single-author YAML schema, low adoption); the `unified-product-graph` MCP server's taxonomy **disambiguates `growth_campaign` from `marketing_campaign_plan`** — a useful precedent that the word "campaign" needs namespacing.

**Bottom line for Phase 8:** Marketr must define its own Campaign object, modeled closest to HubSpot's asset-container semantics — because no vendor and no 2026 standard provides a true cross-channel one, and AdCP/AAMP only cover the paid-media slice.

---

## Track 3 — Agent memory architectures (2026)

**Headline: the 2025–26 consensus converged on a three-store architecture** — episodic (what happened: raw episodes, sessions, transcripts), semantic (distilled facts, preferences, entity knowledge), procedural (how-to: playbooks, SOPs, what worked/what failed). The distinctions line up with Mem0's add/update/delete consolidation, Graphiti's episodic→semantic extraction pipeline, and Letta's tiered memory blocks.

### System-by-system state of play (all open-source-friendly, Postgres-compatible)
- **Letta/MemGPT** — tiered memory (memory blocks + recall + archival, pgvector-backed) plus "sleep-time compute": an async background agent rewrites memory off the request path. Vendor benchmark (Aug 2025): plain agent with filesystem tools scored 74.0% on LoCoMo vs Mem0's 68.5% — their argument: tool-use competence beats retrieval cleverness; measure end-task performance, not recall scores. *(Vendor benchmark — directional.)*
- **Mem0** — write-time fact extraction with add/update/delete consolidation, auto-categorization + contradiction detection. Paper (arXiv 2504.19413): 26% relative improvement over OpenAI memory on LoCoMo, 91% lower p95 latency and >90% token savings vs full-context. 2026 self-reported numbers (92.5% LoCoMo, 94.4% LongMemEval) use incompatible judges — not comparable. *(Vendor self-reported.)*
- **Zep / Graphiti** — **bi-temporal knowledge graph**: every edge carries `valid_at/invalid_at` (world time) plus `created_at/expired_at` (transaction time); new facts *invalidate* old edges rather than deleting them. The key differentiator for "facts change over time" (budgets change, contacts change — old facts stay relevant for episodes about that era). Zep's rebuttal to Mem0 is credible on one point: LoCoMo conversations are only 16–26k tokens and a **full-context baseline gets ~73%**, so the benchmark is weak at discriminating real memory systems. *(Benchmark dispute between vendors; no neutral arbiter.)*
- **LangGraph** — checkpointing + long-term memory stores: the default "good enough" production pattern, widely used, less exotic.
- **Anthropic "7 Layers of Memory"** (March 2026, via secondary sources): conversation context → project knowledge → cross-project knowledge — the industry reference model for scoping.
- **Hindsight (Vectorize.io)** — multi-strategy retrieval, best-published numbers (91.4% LoCoMo, arXiv:2512.12818, Dec 2025), but proprietary/managed — not self-hostable.

### What correlates with benchmark performance (parcha-ai, Sept 2026 — practitioner briefing)
Five patterns with "nearly linear" correlation to performance:
1. **Multi-strategy retrieval is the single biggest differentiator** (Hindsight 4 strategies 91.4% > Zep 3 strategies 71.2% > Mem0 1–2 strategies 49%).
2. Hybrid storage (graph + vector) beats either alone — graph for relationships, vector for breadth.
3. **Explicit temporal modeling gives the largest single gains on temporal queries (+20–60 points).**
4. **Active consolidation** (background refine/invalidate/prune) prevents degradation at scale — "teams that skip this report retrieval quality degrading months in, and by the time it's noticed the cleanup backlog is large" (Medium production field note, Sept 2026).
5. Agent-controlled memory (Letta filesystem pattern) can beat purpose-built retrieval infra.

### Retrieval patterns — the proven production recipe
**Hybrid (BM25 + vector) with cross-encoder rerank.** Multiple independent 2026 reproductions agree:

| Setup | Recall@5/@10 | nDCG |
|---|---|---|
| Pure vector | 0.875 / 0.914 | 0.842 |
| Hybrid (BM25+vector, RRF) | 0.896 / **0.938** | 0.868 / 0.839 |
| Hybrid + cross-encoder rerank | **0.979** / 0.836 | **0.927** / 0.700 |

- The **reranker is the biggest single lever** (+0.059 nDCG / +0.083 recall — larger than the hybrid gain itself).
- Anthropic's contextual-retrieval study: hybrid + rerank **cuts top-20 retrieval misses 67%** (5.7% → 1.9% failure rate).
- Fusion nuance: a **convex combination of normalized scores (one tuned α) beats RRF** in- and out-of-domain, and ~40 labeled query–doc pairs suffice to tune α (TOIS; Weaviate defaulted to relative-score fusion over RRF for this reason).
- Production caveats: lift over BM25 alone is +2–9 points NDCG, concentrated in paraphrase/synonym failures; exact-match queries (IDs, error codes) see zero vector benefit; generic embeddings on specialized domains can *reduce* hybrid precision if not fine-tuned.
- **pgvector gotcha (dev.to, Sept 2026):** default `websearch_to_tsquery` joins with AND and returned zero rows for 71 of 171 queries — BM25 must be paired with OR matching. Hybrid (RRF) hit 0.781 recall@10 vs 0.74 pgvector-only.
- Latency (1.5M-passage benchmark, 2026): BM25 p95 ~62ms; hybrid RRF p95 ~535ms; hybrid + cross-encoder p95 ~1.7s. For agent memory (thousands, not millions), expect tens of ms — rerank is the only expensive stage and stays cheap at small candidate pools.

**Takeaway for Marketr:** hybrid BM25+vector with convex-combination fusion (α tuned on ~40 labeled pairs), top-k 20–50, cross-encoder rerank to final top-k, MMR for diversity, recency/time-decay weighting. Runs entirely inside Postgres (pg_trgm/tsvector + pgvector) with a small local reranker model.

### Retention, scoping, forgetting — the consensus
- **Per-tenant isolation from day one.** Retrofitting isolation onto a shared memory pool is repeatedly called out as painful. Enforce **Postgres RLS** (`tenant_id` on memory tables), immutable tenant principals on tool calls. Cross-tenant "shared learning" only at the anonymized playbook level — never per-client facts.
- **Decay-to-floor, not decay-to-delete:** user-told facts decay only to a surfacing floor and stay recallable; agent-inferred facts fade faster; contradictions are *resolved* (superseded with bi-temporal invalidation), not deleted.
- **Consolidation off the request path:** async background worker pool, batched. Write path (ingest + consolidate) separated from read path (retrieval) so heavy consolidation never degrades live latency.
- **Experiment-outcome memory ("what worked / what failed / when"): no 2026 consensus schema exists.** Closest real thing: TRW-memory's "Preventable Rediscovery Ratio" metric (94.3% of near-duplicate learnings surfaced by hybrid retrieval vs 72% BM25) — a *metric*, not a schema. The field guide (rogerstringer.com, 2026) defines the *discipline*: write is selective (decisions, corrections, gotchas + their *why*; not the derivable/trivial/duplicate), stale claims verified before trust, contradictions resolved. **Marketr defines its own outcome-memory schema** — the bi-temporal edge pattern from Graphiti is the right substrate.

### Self-hosted on Postgres — the verdict
**pgvector is the default and it's fine for Marketr's scale.** Unusually consistent 2026 consensus:
- pgvector handles **10–50M vectors on a well-provisioned single node** with sub-100ms p95 at <10M; HNSW tuning is the operational cost. pgvectorscale (Timescale, StreamingDiskANN) pushes further.
- **Where pgvector hits limits:** (1) HNSW working set outgrows RAM → p95 degrades sharply; (2) **filtered search** — pgvector filters *after* the index scan (0.8.0+ iterative scans patch recall at latency cost), Qdrant/Weaviate are filter-native; (3) write-heavy churn bloats Postgres HNSW; (4) vector search competes with OLTP for buffer cache — **isolate the memory workload or it fights the app for cache**.
- **Decision rule (ai-engineering-playbook, 2026): "Default to pgvector until it hurts… Pay for a second store only for a limit you have measured."** At agency scale (thousands of memories/client × hundreds of clients = low millions of vectors), pgvector is squarely in its comfort zone. Graphiti's temporal-graph layer also runs on Postgres originally.
- One caution: **no built-in hybrid search in pgvector** — combine `tsvector`/`pg_trgm` ranking with vector search yourself (RRF or convex fusion in SQL/app code). Planned work, not a free feature.

---

## Track 4 — Honest state of auto-updating a client graph from their stack (2026)

**Blunt summary:** none of the ad platforms give you a firehose. Meta is the only ad platform with a serious webhook push story (actively pushing developers off polling). Everything else is scheduled sync with platform-specific rate-limit budgets; Salesforce and HubSpot have good webhooks for CRM data; WooCommerce webhooks are real but host-dependent; **TikTok and Google Ads are pull-only for reporting**.

| Platform | OAuth / access gating (2026) | Webhooks (push) | Reporting = pull? | Rate limits that matter |
|---|---|---|---|---|
| **Google Ads** | OAuth2 + **developer token**; token needs Google approval (Basic ~2 business days target, real-world = weeks of backlog; Standard up to ~10 days). Unapproved token = test accounts only. Google Cloud OAuth app verification for sensitive scopes. | **None.** | Yes — GAQL `SearchStream`. | **15,000 ops/day Basic** (sliding 24h; reads+mutates both count; each Search/SearchStream = 1 op regardless of rows). Standard = unlimited-ish. Per-second burst limits with backoff. |
| **Meta Marketing API** | Meta app + App Review for marketing permissions; annual **Data Access Renewal** assessment; mandatory user-data-deletion compliance; **embedded signup v2/v3 deprecated Oct 15, 2026**. **Ads MCP server opened to any dev with a Meta app (July 2026)** — alternative integration path. | **Yes — expanding.** July 2026: expanded webhooks (88 notification types on ads endpoint), "stop polling, start pushing" guidance; push delivery doesn't consume rate-limit allowance. | Pull for insights. **Restrictions tightened Oct 2025 (effective Jan 2026): historical data capped — breakdowns beyond 13 months (6 months for frequency) return empty datasets, not errors.** | 200 calls/hour/ad account (rolling). Version migrations every ~6 months cost 2–4 weeks each — budget as recurring engineering. |
| **TikTok Marketing API** | App at business-api.tiktok.com; scopes requested; **approval takes weeks-to-months** (practitioner reports). OAuth2 with `Access-Token` header (not Bearer). Tokens effectively long-lived for first-party app + own ad account. | **None for ads/reporting.** | Yes — Reporting API sync/async. Endpoint-specific, app-level caps; overage → 429. | Budget: nightly reporting pulls per advertiser; batch aggressively. ("600 calls/min" figures cited apply to the *consumer* TikTok API, not Marketing API — treat Marketing API limits as endpoint-specific, requires testing.) |
| **LinkedIn Marketing** | **Partner Program gating — the strictest.** Developer + application vetting (privacy/security review, declared use cases); **no committed review timeline**. Development tier: 500 calls/day/app, 100/day/member; Standard tier via support ticket. | **None for ads.** Social Actions webhook exists but **push disabled in Development tier**. | Yes. | 500/day dev tier is the agency-scale killer — Standard tier approval per use case is the gate. Monthly API versions, ~12-month sunset windows. |
| **HubSpot** | OAuth public app (or private app for single-account). **Project-based apps now** (HubSpot CLI) — UI creation of private apps removed for new accounts **Sept 28, 2026**, existing **Oct 26, 2026**; legacy public apps uncreatable since June 2026. Marketplace listing requires review/certification; distribution ladder: 10 allowlisted accounts private → 25 submitted → unlimited after approval. | **Yes — excellent.** Up to 1,000 webhook subscriptions/app; batched (≤100 events/request, ≤10 concurrent); HMAC-SHA256 signed; 5s response window; ~10 retries over 24h; **webhooks don't count against API rate limits**. | Pull for the rest. | 100 req/10s burst per account (public OAuth apps); CRM Search API separate 5 req/s/account. Token expiry 6h. |
| **Salesforce** | Connected App / External Client App + per-org admin authorization. **Big 2026 change: AppExchange ISV OAuth mandate — PKCE, refresh-token rotation, 30-day idle refresh TTL, IP allowlist — deadline was May 11, 2026;** non-compliant integrations face suspension/de-listing. New partner integrations pushed to **External Client Apps (Spring '26)**. | **Platform Events / Change Data Capture** via CometD streaming — real push, but a *streaming subscription* (long-lived connection per org), not fire-and-forget webhook; outbound messages (SOAP) are the legacy webhook-ish option. | Yes for bulk; Bulk API for large syncs. | **Org-level, not per-app:** 100,000 + 1,000×licenses per 24h (Enterprise; 5,000×licenses on Unlimited/Performance) — **shared with every other integration the client runs**. Concurrent long-running calls capped (25 prod). |
| **Shopify** | Public/custom app OAuth via Partner dashboard. **Since April 2026: all new public apps must be built exclusively on GraphQL Admin API; REST is legacy.** App Store review for public listing (mandatory compliance webhooks). Custom (single-store) apps skip review. | **Yes — good.** GraphQL webhook subscriptions; HMAC-signed; 200 within 5s; ~8 retries over ~4h then dropped. | Pull for the rest (GraphQL cost-based). | GraphQL: 1,000 cost-points/second bucket **per store** — per-client buckets scale linearly (good). |
| **WordPress / WooCommerce** | **No central OAuth.** WooCommerce REST API uses **Consumer Key/Secret** generated per-site by a store admin — no app review, but no programmatic onboarding either: each client hands you keys. Self-hosted = every client's server is its own snowflake. | **Yes — native WooCommerce webhooks** (order/product/customer), but delivery constrained by the **client's PHP server and Action Scheduler queue**; single-threaded/shared hosts delay or drop under load; out-of-order delivery possible. No SLA — host-dependent. | Yes. | No platform-wide limits — limited by each client's hosting. Aggressive polling can get your IP blocked or melt a cheap shared host. **The "effectively manual-export" risk in the stack.** |

### What's genuinely real-time vs scheduled vs manual
- **Real-time (push):** HubSpot webhooks, Shopify webhooks, Salesforce Platform Events/CDC (streaming, needs a persistent subscriber per org), Meta ads webhooks (2026 expansion). WooCommerce webhooks (best-effort, host-dependent).
- **Scheduled sync (pull):** Google Ads (GAQL, daily ops budget), Meta Insights, TikTok Reporting, LinkedIn (all tiers). Plan: daily pulls + 3-day lookback windows (attribution restatements) + full monthly resync.
- **Effectively manual/export:** WooCommerce on weak hosting (treat webhooks as unreliable; poll gently), any client whose admin never completes the OAuth/key handoff, LinkedIn on Development tier (500/day unusable at scale — approval is the gate).

### Rate-limit math at agency scale (the numbers that bite)
- **Google Ads:** 15,000 ops/day/token on Basic. One SearchStream per account per day ≈ 1 op. 100 clients × 5 queries/day = 500 ops — fine. The killer is *granularity*: per-campaign/per-keyword pulls × 100 clients × daily = thousands of ops. Stay at account/campaign rollup daily; go granular only on demand. Standard access (unlimited) is the real answer at scale.
- **Meta:** 200 calls/hour/ad account. 100 ad accounts × 24 hourly pulls is impossible — **must** use async Insights jobs + webhooks and batch accounts. Per-account buckets help (one client's burst doesn't eat another's), but hourly polling per account does not scale.
- **HubSpot:** 100 req/10s **per account** (not per app) — per-client buckets, scales linearly. Comfortable.
- **Salesforce:** org-level shared budget. A 50-user Enterprise org gets ~150,000 calls/24h *shared with every other integration the client runs*. A client's own noisy integrations can starve you. Monitor per-org usage; it's their budget, not yours.
- **TikTok:** app-level caps shared across all your clients — the one shared bucket in the ad set. Batch reporting windows and cache aggressively.
- **LinkedIn:** the gate isn't rate math, it's *access* — Development tier unusable for an agency product; Standard tier approval per use case is the project.

**Sync architecture recommendation:** webhook-first where real (HubSpot, Shopify, Salesforce CDC, Meta ads webhooks); scheduled-pull everywhere else with per-platform budgets; treat WooCommerce as scheduled-poll with webhook opportunism. Agency-scale design centers: **one OAuth app, per-client tokens, per-platform rate budgets, async jobs for everything** — and LinkedIn Standard-tier approval + Google Standard token access are the two longest-lead external dependencies to start on day one. (TikTok US regulatory status unverified — flag as platform-risk footnote, not a technical blocker.)

---

## Three architectural directions — with trade-offs and a recommendation

### Direction A — Postgres-native substrate (recursive CTEs / JSONB / ltree + pgvector)
Everything in the existing Postgres 16: `graph_nodes` / `graph_edges` tables with recursive-CTE traversals, JSONB properties, bi-temporal columns on edges; memory retrieval via `pgvector` (HNSW — confirmed shippable in our bundled PG) + `tsvector`/`pg_trgm` hybrid with convex-fusion in SQL; RLS for tenant isolation; append-only `graph_facts` log feeding a materialized current-state projection.
- **Pros:** zero new operational burden (same backup/auth/migration story); tenant isolation is RLS, cheap and kernel-enforced; matches the self-hosted story perfectly; query latency fine at agency scale (low-millions entities, ≤5-hop traversals); pgvector comfort zone covers our memory volume; migration path from 203 existing tables is SQL, not ETL.
- **Cons:** deep traversals (>5 hops) and heavy graph analytics (PageRank, community detection) are awkward; filtered vector search is post-scan (iterative scans patch recall at latency cost); vector workload shares buffer cache with OLTP (mitigate: separate connection pool / read replica guidance, or `SET` memory budgets per role); no built-in hybrid search — we build fusion ourselves.
- **Verdict:** the research consensus default ("default to pgvector until it hurts — pay for a second store only for a limit you have measured").

### Direction B — Dedicated graph store (Neo4j / Memgraph sidecar, or embedded)
A real graph database alongside Postgres: GQL/Cypher traversals, native graph algorithms, Graphiti-style temporal graphs on a purpose-built engine.
- **Pros:** traversals and graph analytics are first-class; GQL is now an ISO standard (Apr 2024); temporal-graph implementations (Graphiti) were born on graph DBs.
- **Cons:** second backup story, second auth story, second tenant-isolation story (per-tenant DBs or label filtering — coarser than RLS); second query language for contributors; real ops burden for self-hosters (the exact users Marketr's self-hosted story serves); Neo4j's license story (GPL-ish commercial dual-license) complicates our AGPLv3 + commercial-white-label plan; Kùzu (the embedded hope) is dead/archived; Memgraph case studies are vendor marketing. At agency scale the UW benchmark says Postgres wins until joins get very deep — which ours don't.
- **Verdict:** power we don't need at a cost we can't afford in v1. Revisit only if a measured traversal workload breaks Postgres.

### Direction C — Event-sourced substrate (append-only fact log → materialized graph + memory projections)
Every ingested datum lands as an immutable fact event; the graph and the memory store are both projections rebuilt from the log; full temporal replay ("what did we know on March 3rd?").
- **Pros:** audit-grade provenance; time-travel queries are natural; projections can be rebuilt/evolved without re-ingestion; closest to the AllegroGraph change-history pattern.
- **Cons:** full event sourcing is the heaviest option — eventual consistency on reads, replay hazards (non-idempotent consumers re-firing side effects), permanent event-versioning tax; no marketing-KG vendor does this as a product — it's infrastructure, and the practitioner guidance is explicit that append-only-facts + projected-view gets 80% of the benefit at 20% of the cost; our batteries need current-state correctness more than replay.
- **Verdict:** take the 80%: append-only `graph_facts` log + bi-temporal edges give us time-travel and provenance without the event-sourcing tax. Full CQRS/event-sourcing is a v2+ option if compliance workloads demand it.

### Recommendation: A with C's fact-log discipline (and B explicitly deferred)
**Postgres-native graph + append-only fact log + pgvector hybrid memory, per-tenant RLS from day one.** Bi-temporal edges (Graphiti-style `valid_at/invalid_at` + `created_at/expired_at`) supply the temporal modeling that the research identifies as the single biggest recall lever on time-sensitive queries. Consolidation runs as an async background worker off the request path. No second store in v1; the spec carries a measured-limit tripwire (p95 retrieval latency, HNSW working-set size) for when B becomes worth revisiting.

### What could NOT be verified
- Independent 2026 query-latency benchmarks for marketing-KG workloads at SMB scale (only vendor claims + the older UW study).
- Apache AGE or Kuzu-fork ("bighorn") production maturity in 2026.
- Field-level schema of HubSpot's parent-child campaign API (not fetched directly).
- Any agency publicly documenting per-client KG operations — evidence comes from KG vendors and data-engineering blogs, not agencies.
- LoCoMo scores across memory vendors are incompatible self-reports — only the *relative* pattern (multi-strategy + temporal + consolidation wins) is honest signal.
- No 2026 consensus schema for experiment-outcome memory — Marketr defines its own.
- TikTok Marketing API endpoint-specific rate limits (portal requires login); Google Ads token review real-world timelines (practitioner reports say weeks vs Google's 2-day target); TikTok US regulatory status.
