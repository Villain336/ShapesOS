# SPEC — Phase 8: The Agentic Substrate (Business Graph + Campaign Object + Growth Memory)

**Status:** SPEC — APPROVED by Tico 2026-09-25 (all 5 open questions decided: Postgres-native graph, webhook+scheduled pull, link-not-replace, strict memory scoping, open-core deferred). Not built.
**Date:** 2026-09-25
**Master plan ref:** `docs/MASTER-PLAN.md` — "Phase 8 — The agentic substrate: Business Graph + Campaign object + Growth Memory (2–3 cycles)"; §3.1 autopilot money rules (structural invariants)
**Research:** `docs/phase8-research.md` (four tracks, all 2026-current: KG evidence, campaign-object evidence, agent-memory architectures, sync honesty) + deep memos in the parent agent's context

---

## 1. What Phase 8 builds

Three build tracks, in a hard order. **The orchestrator is only as smart as its memory; this substrate is the moat — but it is read/compute substrate, not spending authority.**

| Track | What | Why this order |
|---|---|---|
| **G1 — Business Graph** | Per-client knowledge graph: the 15 master-plan entity types (customers, competitors, products, services, prices, brand, employees, locations, historical campaigns, reviews, website, CRM, sales performance, creative assets, keywords, content, channels) plus offers, audiences/segments, landing pages — continuously updated, so no agent call starts from zero | The substrate everything else reads. Entity resolution, provenance, and sync plumbing must exist before anything links to it |
| **G2 — Campaign object** | First-class cross-channel entity under one ID (research → offer → audience → messaging → landing page → ads → email/SMS → social → retargeting → CRM pipeline → lead scoring → reporting) — ending campaign fragmentation across ten systems | Needs the graph (entities to link) and must absorb the existing fragments (OutreachCampaign, MailCampaign, MediaBuy, CtvCampaign, NewsletterBroadcast, SocialPost, Experiment) without a big-bang rewrite |
| **G3 — Growth Memory** | Every experiment and outcome recorded — what worked, what failed, when — queryable by every agent. The Test Lab's F3 archive sink is the seed | Builds on the graph (temporal facts) and the campaign object (outcome context); the sink schema from Phase 7 finally gets its store |

### The core design decisions

1. **Postgres-native substrate, no second store in v1.** The 2026 evidence is unusually consistent: at agency scale (low-millions entities, ≤5-hop traversals, low-millions memory vectors), Postgres with recursive CTEs + JSONB + pgvector beats a dedicated graph store on total cost — and the self-hosted story can't carry a second backup/auth/tenant story. pgvector ships in our bundled Postgres (`CREATE EXTENSION vector`). The spec carries a measured-limit tripwire for revisiting, not a vibes-based one.
2. **Append-only facts, bi-temporal edges, materialized current state.** Every ingested datum lands in an immutable `graph_facts` log with source provenance; edges carry `valid_at/invalid_at` (world time) + `created_at/expired_at` (transaction time) Graphiti-style — new facts *invalidate* old edges rather than deleting them. This is the single highest-ROI pattern from the memory research: temporal queries ("what was true when we ran that campaign?") gain +20–60 points from explicit temporal modeling. Full event-sourcing/CQRS is deliberately *not* adopted — the log + projection gets 80% of the benefit at 20% of the cost.
3. **Entity resolution is continuous and reversible.** Cascading matchers (deterministic rules → embedding blocking → human review for the ambiguous), `SAME_AS` provenance edges back to source records, merges reversible. ER is a pipeline with a human review queue, not a batch job.
4. **The Campaign object links; it does not re-model.** Marketr defines its own object with HubSpot-container-like semantics (a container of linked channel assets + roll-up reporting, 3-level parent-child hierarchy) — because no vendor and no 2026 standard provides a true cross-channel campaign object, and AdCP/AAMP only cover the paid-media slice. Ad-platform hierarchies are stored as opaque refs + hierarchy snapshots; the object never pretends Meta's ad sets and Google's ad groups unify.
5. **Migration is link-not-replace.** The 203 existing tables keep their rows. A backfill job *proposes* links (naming-convention + `utm_campaign` matching, the industry's pragmatic hack) and a human confirms. New campaigns are created through the object going forward. No big-bang remodel, no data migration that can corrupt seven phases of history.
6. **Memory is three stores with one retrieval contract.** Episodic (what happened), semantic (distilled facts, bi-temporal), procedural (learnings: the F3 outcome schema — hypothesis/action/result/metric-delta/timestamp/invalidated-at). Retrieval is hybrid BM25+vector with convex-combination fusion (α tuned on ~40 labeled pairs), cross-encoder rerank (local small model), MMR + recency decay — the proven 2026 production recipe, entirely inside Postgres.
7. **Consolidation is async and off the request path.** A background worker pool ingests, distills, invalidates, and prunes; the read path never waits for it. Decay-to-floor (user-told facts persist, agent inferences fade); contradictions resolved via invalidation, never silent deletion.
8. **Tenant isolation is RLS from day one.** Every graph/memory table carries `workspace_id` with Postgres row-level security — retrofitting isolation later is repeatedly documented as painful. Cross-client learning happens only at the anonymized playbook level (the feed for Phase 9's Agent Playbooks), never per-client facts.
9. **Sync honesty is a product feature.** Every node carries freshness labels ("as of X, from Y"). Webhook-first where real (HubSpot, Shopify, Meta ads webhooks, Salesforce CDC); scheduled-pull everywhere else with per-platform rate budgets; WooCommerce treated as scheduled-poll with webhook opportunism. The UI never implies real-time where the platform only offers daily pulls.
10. **"No agent call starts from zero" is a contract, not a slogan.** Every agent invocation receives a context packet: the relevant graph slice + recalled memories, assembled by a single `substrate.context()` call. Phase 9's orchestrator consumes this contract; Phase 8 defines and proves it.

---

## 2. Track-by-track build plan

### G1 — Business Graph

**Entity model.** The 15 master-plan types plus offers, audiences/segments, landing pages, forms/CTAs. Each entity type has a minimal canonical schema (typed columns for the queryable core: names, dates, amounts, geo) + JSONB `properties` for the long tail. Canonical dedupe key per type (e.g., `domain` for Company, `email` for Person, `sku`/`url` for Product).

**The three tables (+1):**
- `graph_facts` — append-only, immutable: source (connector id / manual / import / onboarding), source_record_id, entity_ref, fact_type, payload JSONB, observed_at, ingested_at, content hash. Nothing here is ever updated or deleted (retention policy may archive to cold storage, never mutate).
- `graph_nodes` — the resolved current state: entity_type, canonical_key, display_name, core columns, properties JSONB, first_seen, last_seen, freshness (as_of, source), merged_into_id (for absorbed duplicates).
- `graph_edges` — typed relationships with bi-temporal validity: from_node, to_node, edge_type (e.g., `WORKS_AT`, `COMPETES_WITH`, `RAN_ON`, `TARGETS`, `VARIANT_OF`, `SAME_AS`), properties JSONB, valid_at/invalid_at, created_at/expired_at, source_fact_id, confidence.
- `graph_er_queue` — ambiguous merge candidates for human review: candidate node pair, matcher signals, confidence, status (pending/approved/rejected), decided_by.

**Entity resolution pipeline:** deterministic rules first (exact email/phone/domain/sku match) → embedding blocking for fuzzy candidates (name/address similarity) → human review queue below the auto-merge confidence threshold. Every merge writes `SAME_AS` edges to the absorbed source nodes — merges are auditable and reversible. Louvain-style community detection over shared-identifier nodes as a v2 disambiguation upgrade (not v1).

**Connector framework (three tiers, honest labels):**
- **Tier W (webhook/push):** HubSpot (1,000 subscriptions/app, HMAC-signed), Shopify (GraphQL webhooks), Meta ads webhooks (88 notification types, 2026 expansion), Salesforce Platform Events/CDC (CometD streaming subscription per org). Signature verification mandatory; replay protection; dead-letter queue on repeated failures.
- **Tier S (scheduled pull):** Google Ads (GAQL SearchStream, daily ops budget — Basic 15k ops/day), Meta Insights (async jobs, not hourly polling), TikTok Reporting (nightly, batched), LinkedIn (all tiers). Per-platform rate budgets enforced in the job runner; 3-day lookback windows for attribution restatements; full monthly resync.
- **Tier M (manual/assisted):** WooCommerce consumer key/secret per-site handoff + gentle polling (never melt a shared host), CSV import, and the **onboarding wizard** — the Phase 6 Intelligence Report's 12 audits bootstrap the initial graph (competitors, keywords, content, reviews, local entities seeded from day one).
- `graph_sync_jobs`: connector_id, workspace_id, tier, schedule/cursor state, rate_budget, last_run, last_success, error_count, backoff_until. All sync work runs as async jobs — nothing on the request path.

**Freshness contract:** every node and edge exposes `as_of` + `source`. The UI renders staleness honestly ("Competitor prices as of 3 days ago · Google Ads pull"). The graph-completeness battery asserts freshness labels exist, not that data is fresh — freshness is a measurement, not a promise.

**Longest-lead external dependencies (start day one):** LinkedIn Standard-tier approval (no SLA, Development tier unusable at agency scale) and Google Ads Standard token access (Basic approval backlog is weeks in practice). v1 works fully on Tier W+M plus Tier S at Basic levels; these two unlock scale.

### G2 — Campaign object

**The object.** `campaigns`: name, objective (lead_gen | sale | awareness | retention | launch), status (draft|active|paused|complete|archived), `stages` JSON (each of the 12 master-plan stages — research, offer, audience, messaging, landing page, ads, email/SMS, social, retargeting, CRM pipeline, lead scoring, reporting — with per-stage status + linked object refs), budget_rollup_cents (computed, read-only), reporting config, `parent_campaign_id` (HubSpot-style 3-level hierarchy: e.g., "2026 Q4" → "Holiday Launch" → "Holiday Email Wave 2"), workspace isolation throughout. Name it `growth_campaign` in code to borrow the disambiguation precedent — the word "campaign" is overloaded across ten existing tables.

**The links.** `campaign_links`: campaign_id, linked_type (enum of the fragment tables: mail_campaign, outreach_campaign, media_buy, ctv_campaign, newsletter_broadcast, social_post, experiment, recycling_brief, …), linked_id, role (primary|supporting), link_source (human|naming_convention|utm|api), linked_at. Links are first-class rows with provenance — not a JSON array — so unlinking is surgical and auditable.

**Platform refs stay opaque.** Each link may carry `platform_ref` (platform, platform_campaign_ref, hierarchy_snapshot JSON, budget semantics note). The object never re-models Meta's ad sets or Google's asset groups — it links to them and snapshots what the platform said at link time. Performance Max's flattened hierarchy is stored as-is.

**Migration: link-not-replace.**
1. New `campaigns` table ships empty; all existing fragment tables untouched.
2. The **backfill proposer** scans fragment tables per workspace and proposes links via naming-convention matching (`utm_campaign`, name similarity, date proximity, shared audience/creative) — the same hack HubSpot's Automated Ad Association uses, because it's the only hack the industry has.
3. Every proposal lands in a human review queue; links materialize only on approval. Precision over recall — an unlinked fragment is honest; a wrong link corrupts reporting.
4. New campaigns are created through the object going forward; the per-channel builders offer "attach to campaign" at creation time.

**Reporting roll-up.** The campaign detail aggregates the linked fragments' metrics (spend, sends, opens, clicks, conversions, revenue-influenced via C2 attribution) into one view with per-fragment provenance labels. No cross-platform metric is ever silently summed where semantics differ (e.g., Meta "conversions" vs CRM "closed-won" stay labeled).

### G3 — Growth Memory

**Three stores, one retrieval contract:**
- `memory_episodes` — raw what-happened: run/session records (reallocation runs, experiment runs, sync jobs, agent invocations), timestamps, actor, summary, links to graph nodes/campaigns. Immutable; retention-archived, never edited.
- `memory_facts` — distilled semantic facts: subject (graph node ref), predicate, object, confidence, valid_at/invalid_at + created_at/expired_at (bi-temporal, Graphiti-style), source (episode ref / human / import). Contradictions resolved by invalidation, not deletion.
- `memory_learnings` — procedural outcomes, **the F3 archive sink schema made real**: hypothesis, action, result (worked|failed|inconclusive), metric_delta JSON, observed_at, invalidated_at, context refs (campaign, experiment, channel). Seeded by backfilling every `experiment_results` row and every `IntelligenceReport` opportunity outcome. This is the "what worked, what failed, when" store.

**Write discipline (the 2026 field-guide rules):** selective writes (decisions, corrections, gotchas + their *why* — not the derivable, trivial, or duplicate); stale claims verified before trust; every write carries provenance. The F3 sink's forward-compatible schema is adopted as v1 of `memory_learnings` — no schema migration needed for the seed data.

**Retrieval: `memory_recall()`.** Hybrid `tsvector`/`pg_trgm` + pgvector HNSW over a unified memory index view; convex-combination fusion with α tuned on ~40 labeled query–doc pairs (kept as a fixture set in the repo); cross-encoder rerank via a small local model (no external API on the recall path — self-hosted story); MMR for diversity + recency/time-decay weighting. Top-k 20–50 → rerank → final top-k with provenance (which store, which episode, valid-at timestamp). Exact-match queries (IDs, error codes) bypass the vector component — the research shows zero vector benefit there.

**Consolidation worker (async, off the request path).** Batched background pool: distills episodes → facts, detects contradictions (invalidate, don't delete), prunes to floor (decay-to-floor: user-told facts persist, agent inferences fade), dedupes near-duplicate learnings (the "Preventable Rediscovery" pattern). Write path and read path are separate connections/pools so consolidation never degrades live recall latency. The memory workload gets its own Postgres role with memory budgets — the research is explicit that vector search will fight OLTP for buffer cache otherwise.

**The context contract.** `substrate.context(workspace_id, task_hint)` → { graph_slice: relevant nodes/edges (bounded, ranked), memories: recalled learnings/facts with provenance, freshness: as-of labels }. Every agent invocation in Phase 9 calls this first. Phase 8 proves the contract with the recall-correctness battery; Phase 9 consumes it.

**Cross-client learning (anonymized only).** A separate `playbook_learnings` projection strips client identity (no names, domains, spend figures — only patterns: "geo-holdout on Meta prospecting showed 0.6× platform-reported ROAS across 12 clients"). This feeds Phase 9's Agent Playbooks. Per-client facts never cross the tenant boundary — RLS enforced, and the anonymization step is itself a reviewed, tested transform.

---

## 3. Key flows

- **B1 — Onboarding bootstrap:** Phase 6 Intelligence Report completes → its 12 audits seed initial graph entities (competitors, keywords, content gaps, reviews, local entities) as `graph_facts` with source=`onboarding` → ER pipeline resolves against any existing nodes → client has a living graph on day one, not an empty schema.
- **B2 — Connector sync (Tier S):** scheduler fires per-platform job → rate-budget check → pull with cursor/lookback → facts appended → ER matching on new entities → affected nodes' `as_of` updated → sync job row updated (last_success, cursor). Failure → backoff with jitter; repeated failure → dead-letter + human alert, never silent.
- **B3 — Webhook ingest (Tier W):** signed webhook arrives → signature verified → fact appended → ER fast-path (deterministic matchers only; fuzzy goes to the queue) → node updated. Webhook volume never touches the request path — queue first.
- **B4 — ER review:** low-confidence candidate lands in `graph_er_queue` → human approves/rejects in the graph UI → merge writes `SAME_AS` provenance (reversible) or marks `NOT_SAME` (negative signal for future matchers).
- **B5 — Campaign creation:** human (or Phase 9 orchestrator) creates `growth_campaign` with objective → stages filled by attaching existing fragments or launching new ones through the per-channel builders → links materialize with provenance → reporting roll-up renders with per-fragment labels.
- **B6 — Backfill linking:** proposer scans fragments → candidate links with match signals → human review queue → approve/reject → links materialize. Rejected candidates recorded as negative signals.
- **B7 — Learning capture:** experiment closes (F3) / reallocation run completes (F1) / campaign completes → structured outcome written to `memory_learnings` (the F3 sink path, now backed by the real store) → consolidation worker distills to `memory_facts` where generalizable.
- **B8 — Recall:** agent (or human in the memory UI) calls `memory_recall(query, workspace_id, as_of?)` → hybrid retrieval → fusion → rerank → top-k with provenance. Temporal queries (`as_of`) resolve against bi-temporal validity — "what did we believe about pricing in March?" returns March-valid facts.
- **B9 — Contradiction:** new fact contradicts an existing `memory_facts` row → old row invalidated (`invalid_at`/`expired_at` set, never deleted) → new row linked to the old via `SUPERSEDES` edge → both remain queryable for their valid eras.
- **B10 — Context assembly:** `substrate.context()` composes the graph slice + recalled memories + freshness labels into the packet every agent call starts from. This is the "no agent call starts from zero" proof.

---

## 4. Data model

Workspace-isolated throughout (RLS on every table). New tables (12):

**G1 — Business Graph:**
- `graph_facts` — id, workspace_id, source (connector_id|manual|import|onboarding), source_record_id, entity_ref, fact_type, payload JSONB, observed_at, ingested_at, content_hash. Append-only: no UPDATE/DELETE in application code (retention archival only).
- `graph_nodes` — id, workspace_id, entity_type (enum: customer|competitor|product|service|price|brand|employee|location|campaign_ref|review|website|crm_record|creative_asset|keyword|content|channel|offer|audience|landing_page|form_cta), canonical_key, display_name, core JSONB (typed queryable core), properties JSONB, first_seen, last_seen, as_of, as_of_source, merged_into_id
- `graph_edges` — id, workspace_id, from_node_id, to_node_id, edge_type, properties JSONB, confidence, valid_at, invalid_at, created_at, expired_at, source_fact_id, superseded_by_id
- `graph_er_queue` — id, workspace_id, node_a_id, node_b_id, matcher_signals JSONB, confidence, status (pending|approved|rejected), decided_by, decided_at
- `graph_sync_jobs` — id, workspace_id, connector_id, tier (webhook|scheduled|manual), schedule_cron, cursor_state JSONB, rate_budget JSONB, last_run_at, last_success_at, error_count, backoff_until, status
- `graph_connectors` — id, workspace_id, platform (hubspot|salesforce|shopify|woocommerce|google_ads|meta|tiktok|linkedin), auth_ref (vault), tier, status (connected|pending|error|revoked), scopes_granted, webhook_secret_ref

**G2 — Campaign object:**
- `campaigns` — id, workspace_id, name, objective, status (draft|active|paused|complete|archived), stages JSONB, budget_rollup_cents (computed), reporting_config JSONB, parent_campaign_id (≤3 levels), created_by, created_at
- `campaign_links` — id, campaign_id, linked_type (enum of fragment tables), linked_id, role (primary|supporting), link_source (human|naming_convention|utm|api), platform_ref JSONB, linked_at, linked_by
- `campaign_link_proposals` — id, workspace_id, campaign_id?, linked_type, linked_id, match_signals JSONB, confidence, status (pending|approved|rejected), decided_by

**G3 — Growth Memory:**
- `memory_episodes` — id, workspace_id, episode_type (run|session|sync|agent_call), actor, summary, refs JSONB (graph nodes, campaigns), started_at, ended_at. Immutable.
- `memory_facts` — id, workspace_id, subject_node_id, predicate, object JSONB, confidence, valid_at, invalid_at, created_at, expired_at, source_episode_id, superseded_by_id
- `memory_learnings` — id, workspace_id, hypothesis, action, result (worked|failed|inconclusive), metric_delta JSONB, observed_at, invalidated_at, context_refs JSONB (campaign/experiment/channel), source (test_lab|reallocation|campaign|human|import)
- `playbook_learnings` — id, pattern_title, pattern_body, supporting_client_count, first_observed, last_observed, anonymization_reviewed_by, reviewed_at. **No workspace_id — deliberately cross-tenant, anonymized, human-reviewed before publication.**

Extensions: `pgvector` (HNSW index on the memory index view's embedding column), `pg_trgm` for fuzzy matching support. Both `CREATE EXTENSION` in the migration; the migration fails honestly with setup guidance if the extension is unavailable (self-hosters on minimal Postgres).

---

## 5. API routes

Base: `app/api/substrate/*` (new top-level namespace — the graph, campaign object, and memory are platform substrate, not a feature dashboard).

**G1 — Graph:**
- `GET /api/substrate/graph/nodes?type=&q=` (search + filter) · `GET /api/substrate/graph/nodes/:id` (node + edges + freshness + provenance chain back to facts)
- `GET /api/substrate/graph/edges?node_id=` · `POST /api/substrate/graph/edges` (manual relationship assertion, human-only)
- `GET /api/substrate/graph/facts?entity_ref=` (append-only log view — the audit trail)
- `GET /api/substrate/graph/er-queue` · `POST /api/substrate/graph/er-queue/:id/resolve` (approve/reject merge)
- `GET /api/substrate/graph/connectors` · `POST /api/substrate/graph/connectors` (OAuth/key handoff start) · `POST /api/substrate/graph/connectors/:id/sync` (manual trigger) · `DELETE /api/substrate/graph/connectors/:id` (revoke — stops sync, keeps history)
- `POST /api/substrate/graph/webhooks/:platform` (signed ingest endpoint per Tier-W platform)
- `GET /api/substrate/graph/completeness` (the battery's live view: entity-type coverage, freshness distribution)

**G2 — Campaign object:**
- `POST /api/substrate/campaigns` · `GET /api/substrate/campaigns` · `GET /api/substrate/campaigns/:id` (object + stages + links + roll-up)
- `POST /api/substrate/campaigns/:id/links` (attach fragment — human or orchestrator) · `DELETE /api/substrate/campaigns/:id/links/:linkId` (surgical unlink)
- `GET /api/substrate/campaigns/link-proposals` · `POST /api/substrate/campaigns/link-proposals/:id/resolve`
- `GET /api/substrate/campaigns/:id/report` (roll-up with per-fragment provenance labels)
- `POST /api/substrate/campaigns/:id/children` (sub-campaign, ≤3 levels)

**G3 — Memory:**
- `POST /api/substrate/memory/recall` { query, as_of?, top_k? } → ranked memories with provenance (the battery's entry point)
- `GET /api/substrate/memory/learnings` (filterable library: result, channel, date range)
- `POST /api/substrate/memory/learnings` (human-asserted learning; agent writes go through the consolidation worker, not this endpoint)
- `GET /api/substrate/memory/episodes/:id`
- `GET /api/substrate/memory/consolidation` (worker status: queue depth, last run, distilled/pruned counts)
- `POST /api/substrate/context` { task_hint } → the context packet (graph slice + memories + freshness) — the Phase 9 contract, proven in Phase 8

---

## 6. UI routes

- `/dashboard/substrate` — substrate overview: graph completeness meter, sync health by connector, open ER queue count, recent learnings, context-packet inspector (what would an agent receive for a sample task?)
- `/dashboard/substrate/graph` — entity explorer (type filter, search, node detail with edges/facts/provenance timeline), ER review queue, connector management (connect, sync-now, revoke), sync job history with per-platform rate-budget display
- `/dashboard/substrate/campaigns` — campaign list (hierarchy-aware), campaign detail: 12-stage pipeline view, linked fragments with provenance labels, roll-up report, link manager + backfill proposal queue
- `/dashboard/substrate/memory` — learnings library (worked/failed/inconclusive filters), recall playground (query → ranked results with provenance — the honest demo of the battery), consolidation status, anonymized playbook learnings pending review
- Settings → Substrate: connector OAuth apps, sync cadences, ER auto-merge threshold, memory retention policy, pgvector/consolidation worker tuning

UI follows the Phases 5–7 house pattern (sub-tab nav, plain cards, badges top-right — the Phase 7 drift lesson is now standing convention).

---

## 7. MVP scope

**In:**
- G1: the four tables + connectors table; 15+4 entity types; append-only fact log; bi-temporal edges; cascading ER (rules → embedding blocking → human queue) with reversible merges; Tier-W webhooks (HubSpot, Shopify, Meta ads) with signature verification; Tier-S pull framework with per-platform rate budgets (Google Ads, TikTok, LinkedIn, Meta Insights); Tier-M (WooCommerce keys, CSV import, onboarding-wizard bootstrap from the Intelligence Report); freshness labels everywhere; Salesforce CDC as Tier-W (streaming subscriber per org)
- G2: `growth_campaign` object with 12-stage lifecycle + 3-level hierarchy; `campaign_links` with provenance; opaque platform refs; link-not-replace migration with human-confirmed backfill proposals; roll-up reporting with per-fragment labels
- G3: three memory stores; F3 sink schema adopted as `memory_learnings` v1 with backfill from all `experiment_results` + Intelligence Report outcomes; hybrid retrieval (tsvector/pg_trgm + pgvector, convex fusion, local cross-encoder rerank, MMR + recency); async consolidation worker on a separate pool/role; RLS tenant isolation; `substrate.context()` contract; anonymized `playbook_learnings` with human review gate
- The three master-plan exit proofs as automated batteries (see §10)

**Out (non-goals):**
- Dedicated graph database (Neo4j/Memgraph/embedded) — deferred behind the measured-limit tripwire
- Full event-sourcing/CQRS — the fact log + projection is the v1; replay infrastructure is not built
- Real-time CDC via Debezium/Kafka — Tier-W webhooks + Tier-S pulls cover v1; Debezium is a v2 scale option
- Graph analytics (PageRank, Louvain community detection) — v2; ER uses deterministic + embedding methods in v1
- Auto-merge above the confidence threshold without human review — the ER queue is human-decided in v1
- Automatic campaign linking without human confirmation — precision over recall, permanently in v1
- Cross-client fact sharing of any kind — only anonymized, human-reviewed playbook patterns cross the boundary
- Any spending authority — §3.1: the substrate reads, recalls, and links; execution stays behind existing approval objects

---

## 8. Monetization (per master plan §4)

- **Hosted:** Business Graph as an agency-tier feature (the onboarding Intelligence Report becomes a *living* report — "your graph, continuously updated" is the retention story); Campaign object bundled (the fragmentation-killer is a wedge demo: "every channel, one ID"); Growth Memory as platform-tier uplift (Phase 9 missions consume it — memory quality is what makes the orchestrator worth paying for).
- **Self-hosted:** BYO connector OAuth apps, LLM keys, embedding/reranker models (local defaults documented); Marketr charges nothing on sync volume or recall count.
- **Metering:** new meters for connector sync jobs (per-platform, per-run), recall queries (the expensive rerank stage), consolidation worker runs. Pass-through costs (none in v1 — all compute is local) tracked separately from margin per §3.3.
- The substrate is the compounding story: every phase's data lands in the graph, every outcome lands in memory, every campaign links its fragments — Phase 9's orchestrator inherits all of it.

---

## 9. Safety invariants

These are structural, not configurable. A build that violates any of them fails the phase.

1. **§3.1 applies in full.** Nothing in Phase 8 moves money, grants spending authority, or widens any existing envelope. The graph is read/compute; the campaign object orchestrates through existing approval objects; memory recalls. Any execution path touching spend must pass through Phase 5/F1 approval machinery — no new paths are created.
2. **Tenant isolation is RLS from day one.** Every graph/memory table carries `workspace_id` with row-level security enforced at the database level, not just `WHERE` clauses. The battery includes cross-tenant recall attempts that must return empty.
3. **No per-client fact crosses the tenant boundary.** `playbook_learnings` is the only cross-tenant table; rows enter it only through the anonymization transform *and* a human review gate. The anonymization is a tested transform with adversarial fixtures (names, domains, spend figures must not survive).
4. **Facts are append-only.** Application code never UPDATEs or DELETEs `graph_facts` or `memory_episodes`. Corrections are new facts / invalidations. Retention archival moves rows to cold storage; it never mutates them.
5. **Contradictions invalidate, never delete.** Bi-temporal invalidation preserves every era's truth. A memory system that silently rewrites history cannot be audited.
6. **ER merges are reversible and human-gated.** No auto-merge above the confidence threshold without human decision in v1; every merge carries `SAME_AS` provenance back to source records.
7. **Campaign links are proposed, not assumed.** Backfill proposals require human confirmation. A wrong link corrupts reporting silently — precision over recall.
8. **Webhook ingest verifies signatures.** Every Tier-W endpoint verifies HMAC/platform signatures and rejects unsigned payloads. Replay protection on all ingest endpoints.
9. **Credentials live in the vault.** OAuth tokens, consumer secrets, webhook secrets — never in the graph, never in memory payloads, never in logs. The memory write path scrubs secret-shaped values before persistence (tested with fixtures).
10. **Freshness is labeled, never implied.** Every surfaced node/fact/recall carries `as_of` + source. The UI must not present a 3-day-old pull as current state.
11. **The consolidation worker cannot degrade live recall.** Separate pool, separate role, memory budgets; the read path never waits for consolidation. A stuck worker pages; it doesn't slow queries.
12. **Extension failure is honest.** If `pgvector`/`pg_trgm` can't be created (minimal self-hosted Postgres), the migration fails with setup guidance — never a silent degraded mode that returns worse recall without saying so.

---

## 10. Success metrics / exit gates

1. **Graph-completeness battery green 3×:** seeded fixture client → all 19 entity types present with ≥1 node each; edges connect the expected relationships (product→price, campaign→channel, competitor→keyword); every node carries `as_of` + source; provenance chain from node → edge → fact → source record is traversable; ER fixtures (deliberate duplicates) merge correctly and reversibly; ambiguous fixtures land in the review queue, never auto-merged.
2. **Campaign-object E2E across three channels:** create `growth_campaign` → attach a mail fragment, an email fragment, and an ads fragment → stage pipeline reflects all three → roll-up report renders with per-fragment provenance labels and no silently-summed mismatched metrics → sub-campaign hierarchy (3 levels) resolves.
3. **Backfill precision battery:** fixture workspace with deliberately messy historical fragments (similar names, overlapping dates) → proposer emits candidates → precision ≥95% on human-confirmed links; zero auto-links.
4. **Memory recall correctness proofs green 3×:** planted learnings (worked/failed/inconclusive across channels and dates) → `recall()` returns them ranked with provenance; **temporal proof:** query with `as_of` returns the fact valid *at that time*, not the current one (the bi-temporal payoff); **contradiction proof:** superseded facts remain queryable for their era and the current fact is marked as superseding; **isolation proof:** cross-workspace recall returns empty.
5. **Retrieval quality bar:** on the repo's ~40-pair labeled fixture set, hybrid+rerank beats BM25-only and vector-only on nDCG (the research's proven ordering must reproduce in our stack); exact-match queries (IDs) bypass vector and still return correctly.
6. **Sync honesty battery:** Tier-W webhook fixtures (valid + forged signatures) → valid ingested, forged rejected; Tier-S rate-budget fixtures → job backs off instead of blowing the budget; WooCommerce-on-shared-host fixture → gentle polling, no hammering; every surfaced entity shows honest freshness labels.
7. **Context-contract proof:** `substrate.context()` on a fixture workspace returns a bounded packet (graph slice + memories + freshness) that a stub agent can consume — the Phase 9 handoff, proven in Phase 8.
8. **Anonymization adversarial battery:** fixtures stuffed with names, domains, emails, spend figures → anonymization transform output contains none of them (verified by scan); unreviewed patterns never publish to `playbook_learnings`.
9. Standing bar: TypeScript clean, production build green, M11 security battery green, module batteries green ×3, secret scan clean, independent verification before commit.

---

## 11. Honest limitations

- **Postgres is the bet, and it's a measured one.** If traversals deepen past ~5 hops or HNSW working sets outgrow RAM, latency degrades — the spec carries the tripwire (p95 recall latency, HNSW size vs RAM) rather than pretending the choice is permanent.
- **Entity resolution is never "done."** The ER queue is a permanent UI surface, not a setup wizard — new sources continuously introduce duplicates. Agencies should expect a weekly review habit, not a one-time import.
- **Sync is hourly–daily, honestly labeled.** Anyone expecting a real-time client graph is buying streaming events, not a resolved graph. The freshness labels are the product's honesty mechanism.
- **LinkedIn and Google Ads scale are gated externally.** Standard-tier approval (LinkedIn, no SLA) and Standard token access (Google Ads, weeks of backlog) are the longest-lead dependencies — v1 works without them, scale needs them.
- **WooCommerce is the weak link.** No central OAuth, host-dependent webhooks, per-site key handoffs — this connector will always be the most manual. The spec treats it as such rather than promising parity.
- **The Campaign object can't fix platform semantics.** Meta's ad sets and Google's asset groups remain different things; the object links them and labels the difference. Roll-ups stay honest by staying labeled.
- **No 2026 standard exists for what we're building.** The Campaign object and the outcome-memory schema are Marketr-defined. That's the moat — and the risk: we own the schema evolution.
- **Memory quality compounds slowly.** A new workspace's memory is thin; the value accrues over months of runs. The onboarding bootstrap (Intelligence Report → graph; F3 backfill → memory) exists precisely to shorten the cold start, not eliminate it.
- **Rerank models and embeddings are dependencies.** Local defaults keep the self-hosted story intact, but model quality bounds recall quality — the ~40-pair fixture set is the canary.

---

## 12. Open questions

1. **[APPROVED 2026-09-25] Graph store: Postgres-native.** Postgres-native (recommended) vs. dedicated graph DB.** Recommendation: **Postgres-native with the append-only fact log + bi-temporal edges (Direction A with C's discipline); dedicated graph store explicitly deferred** behind a measured-limit tripwire (p95 recall latency, HNSW working-set vs RAM). The 2026 evidence says Postgres wins at agency scale, the self-hosted story can't carry a second store's ops burden, and Neo4j's licensing complicates our AGPLv3 + commercial-white-label plan. Revisit only on measured pain, not anticipated pain.
2. **[APPROVED 2026-09-25] Auto-update depth v1: webhook-first + scheduled pull.** webhook-first + scheduled pull + manual onboarding (recommended) vs. adding real-time CDC (Debezium/Kafka).** Recommendation: **webhook-first where real, scheduled-pull framework with per-platform budgets, manual/assisted onboarding — no Debezium in v1.** The honest freshness tier for agency marketing is hourly–daily; CDC is infrastructure for a scale problem we haven't measured. The connector framework is built so CDC can slot in as a fourth tier later.
3. **[APPROVED 2026-09-25] Campaign migration: link-not-replace.** link-not-replace with human-confirmed backfill (recommended) vs. big-bang remodel into the new object.** Recommendation: **link-not-replace.** Seven phases of history live in those fragment tables; a remodel risks corrupting it, and the industry's own unification hack is naming-convention association anyway. The backfill proposer + human review queue gives us the unified view without touching a single historical row.
4. **[APPROVED 2026-09-25] Memory retention/scoping: strict.** per-tenant RLS + decay-to-floor + anonymized cross-client playbooks only (recommended) vs. any shared client-fact pooling.** Recommendation: **the strict option.** Per-tenant RLS from day one (retrofitting is documented as painful), decay-to-floor so user-told facts never vanish, and cross-client learning only as anonymized, human-reviewed playbook patterns. No version of "pool client data for better models" in v1 — that's a trust decision, not a technical one.
5. **[APPROVED 2026-09-25] Open-core decision: leave deferred.**** Recommendation: **leave it deferred.** Phase 8 is substrate engineering; the open-core split is a business decision staged in F6's decision brief. Nothing in the substrate changes the options map — but note the interaction: the substrate *is* the likely commercial-moat layer if the split ever goes the three-layer route (open core + commercial substrate), so the decision brief should gain one paragraph noting that.
