# Marketr → Cloudflare migration research: Worker 4 — Cron + Queues + Embeddings/AI

Status: IN PROGRESS (read-only research; repo untouched)
Started: 2026-09-27

---

## 1. CRON INVENTORY — all 25 `/api/cron/*` routes

Gate for every route: `lib/cron/gate.ts` — two actors: (1) `Authorization: Bearer <CRON_SECRET>` service call (all workspaces), (2) signed-in editor+ session (own workspace only, for manual "run now"). CF mapping: CRON_SECRET becomes a Worker `secret`; manual-run actor maps to the existing app auth (Workers → app origin). Cron on CF is at-least-once with ±1min accuracy (UNVERIFIED — community skill docs), so every route's existing idempotency logic must survive duplicate firings.

| # | Route | DEPLOY schedule (current host crontab) | What it does | Duration profile |
|---|-------|----------------------------------------|--------------|------------------|
| 1 | `/api/cron/fix-agent` | `30 6 * * *` (daily) | Scheduled fix-agent applier: every enabled site — picks up per-issue-approved or category allow-listed, non-destructive issues; applies, audits, one-click revert | LONG — unbounded sweep across all workspaces/sites; each site does page fetches + LLM + file ops. Heaviest cron in the fleet. FAN-OUT required. |
| 2 | `/api/cron/reports` | `0 7 * * *` (daily) | Report generation for templates whose weekly/monthly schedule is due; audit-logged as `system` | MEDIUM — per-template PDF/data-gen; bounded by # due templates. Possible fan-out per template. |
| 3 | `/api/cron/platform-radar` | `30 7 * * *` (daily) | Platform-change radar: ingest official sources → classifier → upsert → rollout correlation → Growth Memory → alert hub. One source's failure never fails the run | MEDIUM-LONG — LLM classify per source + embedding writes. Could exceed single-invocation CPU; candidate for per-source fan-out. |
| 4 | `/api/cron/alerts` | `*/15 * * * *` | Flush queued alert events: daily digests due + quiet-hours holds whose window ended | SHORT-MEDIUM — dispatch + channel sends (email etc.). Already queue-like in DB; fits a Cron Trigger → one invocation. Watch: channel sends are external; at-least-once duplicate firing → digest duplication unless keyed (see §2). |
| 5 | `/api/cron/visibility-score` | `0 8 * * *` (daily) | Composite visibility score per project per day + `visibility_delta` WoW alerts | MEDIUM — per project compute across ranking history; bounded per project. |
| 6 | `/api/cron/gsc-pull` | `5 * * * *` (hourly) | Pull last 3h of GSC HOURLY_ALL analytics per GSC-bound project → `gsc_snapshot`; feeds delta engine + radar | MEDIUM — one GSC API round per bound project; hourly cadence. |
| 7 | `/api/cron/gsc-inspection` | `*/15 * * * *` | Drain URL Inspection queue: priority-ordered, fair-share across projects, 2,000 QPD/site hard wall; never full-sweeps | SHORT per tick — drains what's in the queue; self-bounding via QPD wall. Queue-drain pattern: maps well to CF (queue rows in D1 or a real Queue). |
| 8 | `/api/cron/decay` | `0 9 * * 1` (weekly Mon) | Content-decay detection: per project, 90 days of ranking history → upsert findings, auto-resolve recovered, emit alerts | MEDIUM-LONG — 90-day scan per project. Fan-out per project recommended. |
| 9 | `/api/cron/radar` | `30 9 * * 1` (weekly Mon) | Competitor radar: per project × competitor keyword snapshot (DataForSEO Labs when live) → diff | LONG — cost-heavy external API (DataForSEO) per competitor. Fan-out per competitor; external API time is wall-clock, not CPU. |
| 10 | `/api/cron/backlinks` | `0 10 * * 1` (weekly Mon) | Backlink refresh per project with `backlinksEnabled`; hard row cap + workspace monthly spend cap enforced pre-pull | MEDIUM — bounded by caps. |
| 11 | `/api/cron/internal-links` | `30 10 * * 1` (weekly Mon) | Internal-link suggestion refresh; pure compute + suggestion rows, never edits pages | MEDIUM — compute-heavy per site (embeddings + link graph?). Note: may call the local embedder → needs Workers AI swap (see §3). |
| 12 | `/api/cron/fleet` | `0 11 * * 1` (weekly Mon) | Competitor-fleet sweep: sitemap/index diffing, robots-aware polite fetch, AI summaries, licensed review adapters; weekly digest | LONG — many politeness-delayed fetches + AI summaries per watched competitor. Fan-out per workspace/competitor. |
| 13 | `/api/cron/local-grid` | `0 11 * * 1` (weekly Mon) | Geo-grid runs: grids due (enabled, weekly, lastRunAt >7d); cost caps per grid run | LONG — grid runs = many rank-check queries (DataForSEO spend). Fan-out per grid. |
| 14 | `/api/cron/local-competitors` | `30 11 * * 1` (weekly Mon) | Local-competitor snapshot refresh; enabled competitors only | MEDIUM — external API per competitor. |
| 15 | `/api/cron/reviews` | `0 12 * * 1` (weekly Mon) | Review ingest + sentiment summaries + negative-review alerts; requires enabled geo-grid | MEDIUM — external review APIs + LLM sentiment per business. |
| 16 | `/api/cron/autopilot` | `0 7 * * *` (daily) | Content-autopilot: runs only daily/weekly rules whose cadence is due; kill switch, per-run item cap, idempotency, approval gate | MEDIUM-LONG — each rule can generate content (LLM) — fan-out per rule. |
| 17 | `/api/cron/newsletter` | `*/5 * * * *` | Sweep for due scheduled newsletter broadcasts; send guardrails re-enforced at dispatch (verified domain, test send, ≥1 subscriber, unsubscribe link); failures audit-log + M13 alert | SHORT-MEDIUM per tick; external send via Resend. Double-fire risk = double send → check idempotency key on send (see §2). |
| 18 | `/api/cron/social` | `*/5 * * * *` | Dispatch due scheduled posts → Buffer (their queue publishes); bounded retries on transient; per-channel validation + idempotency server-side | SHORT per tick; Buffer idempotency key exists per code comments. |
| 19 | `/api/cron/ads` | `*/5 * * * *` | Ad-factory job sweep: submit queued creatives with no provider job; poll in-flight on 30s cadence (40-attempt cap ~20min); records actual cost/spend | ⚠️ **Sub-minute cadence problem**: poll loop wants 30s cadence but CF cron minimum is 1 minute (UNVERIFIED). Options: Queue consumer with delayed-message requeue, or a separate Workflows loop. |
| 20 | `/api/cron/storage-metering` | `0 2 1 * *` (monthly) | Monthly storage over-quota ledger charge: per whole GB over quota on month-end snapshot; idempotent per workspace per month | SHORT — aggregate scan; idempotent by design. Easy CF cron fit. |
| 21 | `/api/cron/overage-invoicing` | `0 3 1 * *` (monthly) | Stripe overage invoices for completed UTC months; $5 min; replay-safe per workspace per month; no-op without Stripe | SHORT-MEDIUM — Stripe API calls; replay-safe. Fits CF cron. |
| 22 | `/api/cron/connector-refresh` | every 5–15 min (route header; not in DEPLOY §3.8 crontab — doc gap) | Refresh due connector tokens: active connections expiring within 15 min (or expired); idempotent | SHORT — one token-refresh per due connection. Easy fit. **Doc gap: schedule missing from DEPLOY §3.8.** |
| 23 | `/api/cron/nurture` | every few min (route header; "see DEPLOY.md" but no entry found — doc gap) | `advanceEnrollments()`: advance nurture-sequence enrollments across all workspaces; supports "run now" from dashboard | SHORT-MEDIUM per tick. Fits CF cron. **Doc gap: schedule missing from DEPLOY §3.8.** |
| 24 | `/api/cron/messaging` | cadence not documented (route header has none; not in DEPLOY crontab — doc gap) | Dispatch sweep: send every queued, due, approved message; consent/quiet-hours/daily cap/approval re-checked per row; per-message idempotency key `outbound-message:${msg.id}` (lib/messaging/dispatcher.ts:413) | SHORT per tick. Fits CF cron. **Doc gap: schedule missing from DEPLOY §3.8.** |
| 25 | `/api/cron/workflows` | every ~1 min implied ("fires schedule triggers due; at most once per minute per workflow via lastRunAt guard") — not in DEPLOY §3.8 crontab — doc gap | Automation-canvas cron sweep: fires schedule triggers due (workflow-level + schedule-node-level cron exprs) | SHORT per tick; guard makes it idempotent. **Doc gap: schedule missing from DEPLOY §3.8.** |

Plus (not under /api/cron/* but same gate & pattern — for completeness):
- `POST /api/scheduler/tick` — DB-cron engine: claims due `ScheduledSkill` rows (atomic `updateMany` claim, same-tick double-fire impossible), advances `nextRunAt`, fires via guarded path, **missed-cron catch-up: fires ONCE, marks missed, jumps to next future slot** (never replays every missed window — no stampede). Needs its own cron trigger (recommended: every 1–5 min).
- `POST /api/intelligence/radar/run` — same gate; instructs to use `/api/cron/platform-radar` for the service sweep (manual-run shim).
- `POST /api/calls/reminders/run` — same gate; 24h+1h reminders sweep ("intended for a scheduler cron") — needs a host-cron entry it doesn't document. **Doc gap.**
- `POST /api/media/kill-rules/evaluate` — same gate (kill rules for ad spend?). Cadence undocumented.

### Cloudflare Cron Trigger fit analysis

Official docs (UNVERIFIED — from community skill docs + mirrored docs, verified against developers.cloudflare.com limits page 2026-09): 
- Min interval **1 minute**; accuracy **±1 minute**; config propagation up to 15 min; execution **at-least-once** (duplicates possible — call `controller.noRetry()` / make everything idempotent).
- Triggers per Worker: **3 free / unlimited paid** (one source says 5 per account free / 250 paid — discrepancy; UNVERIFIED, take the paid number: unlimited per Worker on paid plan).
- CPU time (cron trigger): **10ms free / 50ms paid-bundled / 15 min paid-unbound**; wall-clock duration **15 min** for cron (per docs limits page). Memory 128 MB per isolate.
- `ctx.waitUntil()` extends background work after the scheduled handler returns (bounded by the duration/CPU limits).

Fit verdicts:

| Bucket | Routes | CF pattern |
|--------|--------|------------|
| **A. Direct fit — one cron trigger per route, enqueue-and-return** | all 25, via a thin `scheduled()` handler | Trigger posts a message to a CF Queue (or D1 outbox) with the route id + idempotency key (`route:<name>:<slot-minute>`); HTTP route handler unchanged, now invoked by the queue consumer. Guarantees at-most-one-execution per slot and decouples from cron CPU limits. |
| **B. Needs fan-out (exceed CPU/wall-clock or external API latency)** | fix-agent, platform-radar, radar, decay, fleet, local-grid, autopilot, visibility-score, backlinks | Cron → claim-due-work rows in D1 (atomic updateMany, existing pattern) → **one queue message per unit of work** (per site/project/competitor/rule) → consumer workers with bounded concurrency. Cost caps already server-side. |
| **C. Needs redesign for sub-minute cadence** | ads (30s poll cadence) | CF cron min = 1 min. Options: (i) poll at 1-min cadence from cron (40 attempts → ~40 min max in-flight window instead of 20); (ii) Queue consumer requeues the message with `delaySeconds` for a 30s self-perpetuating poll (works: message delay up to 12h); (iii) Workflow with `sleep`. Recommended: (ii) — keep 30s cadence, no external scheduler. |
| **D. Self-bounding drains** | gsc-inspection (QPD wall), alerts, newsletter, social, messaging, nurture, workflows, connector-refresh, storage-metering, overage-invoicing | Fits cron directly; keep existing server-side bounds/idempotency. |

Cloudflare cron-expression compatibility: Marketr's `lib/workflow/cron.ts` subset (5-field: `*`, `*/n`, `a-b`, `a,b,c`, literals) maps 1:1 to CF cron syntax (5-field, `/` steps supported). The `/api/scheduler/tick` DB engine (user-defined `cronExpr`) can keep running on CF — its rows are in D1/Postgres; a single `*/1 * * * *` trigger drives the tick, and its atomic-claim + no-stampede catch-up semantics already solve CF's at-least-once duplicate firing. **Do not re-implement user crons as CF cron triggers** — user schedules belong in D1 under the tick engine.

**Watch-outs:**
1. CF cron at-least-once ⇒ duplicate route firings. Routes with weak idempotency: **alerts** (digest duplication — check digest keying), **newsletter** (double send — confirm idempotency key at send), **autopilot** (has per-run item cap + idempotency per code header, good). Fix-agent has the atomic-claim pattern already (good precedent).
2. Doc gaps to fix regardless of CF (routes 22–25 + calls/reminders + kill-rules): schedules live only in code comments, not DEPLOY §3.8. A CF wrangler `[triggers]` block will need one authoritative table — DEPLOY §3.8 should be completed first.
3. Timezones: host crontab runs in server TZ; CF cron triggers fire in **UTC** — all 25 expressions assume a single TZ. Audit each expression for TZ expectations before porting (e.g. `0 7` daily = 7am server time ≠ 7am user TZ today).

---

## 2. QUEUE INVENTORY — DB-backed queue mechanisms → Cloudflare Queues mapping

There is NO dedicated infra queue library (`lib/` has no queue/ dir). All queuing is ad-hoc DB-polling with an established house pattern: **atomic claim via `updateMany` (exactly-one-holder)**, documented as "Day-1 fixes" in ads/newsletter/social. Ordering: **none guaranteed** beyond priority/timestamp ordering per query; retries are counter + `nextPollAt` based. No dead-letter queues exist anywhere — terminal failure = status flip (`failed`) + audit log + M13 alert.

### 2a. Mechanism inventory

| # | Mechanism | Where | Producer → claim → work | Ordering | Poll cadence | Retry / poison semantics |
|---|-----------|-------|-------------------------|----------|--------------|--------------------------|
| 1 | Ad creative job queue | `lib/ads/service.ts` (AdCreative rows) | Cron tick → atomic claim `queued→generating` (updateMany where providerJobId null; exactly one submitter wins) → submit to Higgsfield; poll loop 30s, 40 attempts | Poll order (nextPollAt) | `*/5 * * * *` + 30s internal poll | 3 submit attempts on transient provider error; 40 poll attempts (~20 min) then `failed`. **Reclaim, not resubmit**: if worker dies between claim and provider ack, row reclaimed after 15 min — NEVER auto-resubmits (a charge may exist) → surfaced for human review. No DLQ. |
| 2 | Newsletter broadcast dispatch | `lib/newsletter/service.ts` | Atomic claim `→sending` (updateMany where status notIn [sent, sending]); loser gets `BROADCAST_CLAIM_LOST` (benign, not a failure) | Due-time | `*/5 * * * *` | Failures → `failed` + audit + M13 alert. No DLQ. |
| 3 | Social post dispatch | `lib/social/service.ts` | Atomic claim `→dispatching` (status in [draft, scheduled, failed]); loser gets `DISPATCH_CLAIM_LOST` | Due-time | `*/5 * * * *` | Bounded retries on transient; permanent failure → audit + M13 alert. No DLQ. |
| 4 | Alert hub queue | `lib/alerts/dispatch.ts` (alertEvent rows, status=queued) | `flushQueued()` every 15 min: digest-mode rules batch queued events into one daily digest (gated by `rule.lastDigestAt`); quiet-hours holds sent when window ends | Rule + due | `*/15 * * * *` | ⚠️ **Race**: digest creation checks `lastDigestAt` then creates the digest event in separate statements (no atomic claim) — two concurrent flush ticks could mint two digests for the same rule. Fine on a single host crontab (non-overlapping); breaks if two CF cron instances fire simultaneously. Needs an atomic claim on `alertRule` before hardening. |
| 5 | Outbound messaging queue | `lib/messaging/dispatcher.ts` (message rows) | Sweep: sends every queued/due/approved message; consent, quiet-hours, daily cap, approval re-checked per row; per-message idempotency key `outbound-message:${msg.id}` | Due-time | cron (cadence undocumented — see §1 doc gap) | Claim semantics not verified at row level; relies on provider idempotency key + re-checks. No DLQ. |
| 6 | Nurture enrollments | `lib/messaging/sequences.ts` `advanceEnrollments()` | Picks enrollments with `nextRunAt` due → advances step → queues mail pieces (`queueMailPiece`) | nextRunAt | "every few minutes" (undocumented) | "must not poison the queue — bounce the enrollment" (comment at sequences.ts:346). No DLQ. |
| 7 | GSC URL Inspection queue | Phase 10 M1 (gsc_inspection rows, inferred; 2,000 QPD/site hard wall) | `/api/cron/gsc-inspection` drains priority-ordered, fair-share across projects | Priority + fair-share | `*/15 * * * *` | QPD wall is the backpressure valve; never sweeps. No DLQ. |
| 8 | User-cron engine (ScheduledSkill) | `lib/scheduler/tick.ts` (scheduledSkill rows) | Atomic claim (updateMany advancing nextRunAt in the claim write — concurrent ticks can't double-fire); missed-cron catch-up: **fire once, mark missed, jump to next future slot** (no stampede) | nextRunAt | tick invoked by host cron (every ~1 min implied) | Bad cron expr → parked +1h + audit (`blocked`). No DLQ; failures audit-logged. |
| 9 | Mission event chain | `lib/orchestrator/audit.ts` `appendMissionEvent` (mission_events rows) | Append-only per mission: `prevHash` = previous row's `eventHash` ("GENESIS" for first); read+write inside one Prisma `$transaction` with tenant GUC | ts order within mission | Synchronous (not polled) | **See duplicate analysis below.** |
| 10 | ER review queue | `GraphErQueue` (graph_er_queue rows) | Entity-resolution candidates awaiting human decision (pending → decided) | createdAt | Human-driven | Not an infra queue; migrates as ordinary D1/Postgres rows. |
| 11 | Connector ingest dead-letter | `lib/substrate/graph/connectors/deadletter.ts` | Failed ingest attempts recorded as append-only facts (`fact_type: "ingest_dead_letter"`) | ts | Event-driven | This is the only DLQ-shaped construct in the repo — a fact row, not a requeue. |

### 2b. Does a duplicate break the mission event hash chain?

Short answer: **a true duplicate (retry after commit) does NOT break the chain; a concurrent race can fork it.**

- Retry-after-commit: `appendMissionEvent` reads `last = latest eventHash for mission`, computes `eventHash = sha256(prevHash ‖ missionId ‖ actor ‖ payloadHash ‖ ts.toISOString())`, inserts. If the first insert committed and a retry runs again, the retry reads the *new* last hash (its own first insert) and appends a *second* event with a different hash (ts differs) chained after the first. Chain stays linear and verifiable; the *business* duplication (two rows for one logical step) is visible but doesn't fork the chain. `verifyChain` implementations (`lib/authority/audit.ts`, `lib/flywheel/*/audit.ts`) replay and would accept it.
- Concurrent race: two appends in flight simultaneously can both read the *same* `last.eventHash` inside their transactions (default read-committed — each sees the other's uncommitted row not at all). Both insert with the **same prevHash** → two sibling rows chained to the same parent = a **fork**. Verification keyed on `prevHash == prior row's eventHash` will flag one of them as broken (`brokenAt`). This race exists TODAY on Postgres and is unchanged by CF — but it gets *more likely* if appends fan out to queue consumers with concurrency. Mitigation on migration: serialize appends per mission (single consumer per missionId, or a per-mission lease), or add a unique constraint on `(missionId, prevHash)` — forks would then fail loudly at insert instead of corrupting silently. (Unique constraint recommendation: new, needs a migration + app error handling; report as a follow-up.)
- CF Queues angle: if mission steps ever become queue-driven, at-least-once delivery (see 2c) makes the retry-after-commit duplicate *common*. The chain tolerates it (linear duplicate, not fork), but downstream consumers (cost rollups `costCents`, approval executors re-verifying binding payloads) must be idempotent on event id — currently executors re-verify binding hash, which a duplicate passes. Call out: duplicate event rows are *audit-acceptable* but *billing-sensitive* (costCents double-counted in rollups unless deduped by event id).

### 2c. Cloudflare Queues facts (UNVERIFIED — web research 2026-09-27, community docs + mirrored Cloudflare docs)

- Delivery: **at-least-once, no ordering guarantee**. Per-message `ack()` / `retry({delaySeconds})`; default **max_retries 3** (max 100); messages exceeding retries are deleted or moved to a **dead letter queue** (separate queue declared in wrangler config).
- Message: **128 KB max** (~100 B metadata); `sendBatch` up to **100 msgs / 256 KB total**; throughput ~5,000 msg/s/queue; batch size 1–100, batch timeout 0–60s; message delay up to 12h; retention 4d default / 14d max; backlog 25 GB/queue; 10,000 queues/account; 250 concurrent push consumers.
- Consumer invocation: **15 min wall-clock**; CPU **30s default / 5 min max (paid)**; 128 MB isolate memory.
- Pricing: **requires Workers Paid ($5/mo)**; first **1M operations/month free**, then **$0.40/M ops**; one op per 64 KB written/read/deleted; typical message lifecycle = 3 ops (write+read+delete); retries add read ops. Free-plan numbers floating around (10k ops/day, 24h retention) — CF's own changelog 2026-02-04 mentions a free-plan queues allowance; treat as UNVERIFIED and plan for Paid.
- One secondary source claims producer-side idempotency-key dedupe ("duplicate sends deduplicated at producer") — **could not verify against official docs; do not rely on it.**

### 2d. Mapping table: producer → queue → consumer

Design keeps the existing **atomic-claim DB rows** as the source of truth (they already solve exactly-once *claim*; CF Queues adds durable transport + DLQ). Pattern for every mechanism: cron trigger (or HTTP) → *dispatcher* Worker claims due rows in D1 (atomic updateMany) → `sendBatch` one message per row (message body = IDs only, never payloads) → *consumer* Worker processes each message idempotently (claim-check: re-verify row status before side effect; losers ack-and-skip).

| Mechanism | Producer | Queue | Consumer | What CF Queues buys | What breaks / needs care |
|-----------|----------|-------|----------|---------------------|--------------------------|
| Ad job poll | cron `*/5` dispatcher claims due AdCreative rows | `marketr-ads` | poll consumer (30s self-requeue via `delaySeconds` for in-flight) | DLQ replaces "human review surfacing" for stuck jobs; delayed requeue solves the sub-minute cadence problem (§1C) | Duplicate delivery → double poll is harmless (state machine); double *submit* is spend — keep the atomic claim in D1 before submit; submit itself never in the consumer retry path |
| Newsletter send | cron `*/5` dispatcher claims due broadcasts | `marketr-newsletter` | send consumer | DLQ for permanently failed broadcasts (today: status flip + alert only) | Keep `BROADCAST_CLAIM_LOST` claim; idempotency at Resend send |
| Social dispatch | cron `*/5` dispatcher claims due posts | `marketr-social` | Buffer dispatch consumer | Same | Keep `DISPATCH_CLAIM_LOST` claim; Buffer's queue already dedupes downstream |
| Alert flush | cron `*/15` dispatcher | `marketr-alerts` | flush consumer | Parallel digest fan-out | **Fix the digest race first** (atomic claim on alertRule) or two consumers mint two digests |
| Messaging dispatch | cron dispatcher | `marketr-messaging` | send consumer | DLQ for poison messages (today: none) | Per-message idempotency key `outbound-message:${id}` already exists — perfect CF fit |
| Nurture advance | cron dispatcher claims due enrollments | `marketr-nurture` | step-advance consumer | DLQ for enrollments that "poison the queue" (today: bounced manually) | Step advance must be idempotent on (enrollmentId, step) — verify before migration |
| GSC inspection drain | cron `*/15` dispatcher claims due inspection rows (bounded) | `marketr-gsc-inspection` | inspect consumer | Natural fan-out across projects | QPD wall stays server-side in the claim query; message = row id |
| User-cron tick | **No queue** — keep as-is | — | — | — | Tick is already claim-safe; give it a `*/1` cron trigger. Do NOT map user crons to CF triggers. |
| Mission events | **No queue** — keep synchronous appends | — | — | — | Serialize per mission if consumers ever append concurrently (see 2b) |
| Long sweeps (fix-agent, fleet, radar, local-grid, autopilot, platform-radar, decay, visibility-score, backlinks, reviews, local-competitors, internal-links, gsc-pull) | cron dispatcher claims due *units* (site/project/competitor/rule) | `marketr-sweep` (per domain, or one queue with `kind`) | worker per unit | This is THE fan-out primitive for §1 bucket B; bounded consumer concurrency = cost-cap enforcement | External-API wall-clock time doesn't count against CPU — but 15-min consumer wall-clock does; size units so one unit < 15 min |

Ordering note: **nothing in the repo actually needs global ordering** — every mechanism orders by due-time/priority per query, which survives CF's unordered delivery as long as the consumer re-checks "still due / still claimed" before acting (all atomic-claim paths already do; alert digest flush needs the fix noted above).

**Poison-message story today → on CF:** today, poison = counter cap → status `failed` + audit + M13 alert (ads: 40 polls / 3 submits; alert: none). On CF this maps cleanly to **DLQ + `max_retries`**: configure `max_retries: 3` on consumers, DLQ per domain queue, and keep the M13-alert emission on DLQ landing (replacing today's status-flip alert). Net effect: poison handling *improves* (central DLQ inspection vs scattered `failed` rows).

---

## 3. EMBEDDINGS — the onnxruntime problem and three options

### Current state (verified in repo)

- **Model**: `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers` v2.17.2 (`lib/substrate/memory/embed.ts`). Note on the seed fact: it is **transformers.js**, not onnxruntime directly — but transformers.js in Node loads **onnxruntime-node**, a native binding with a platform `.so`/`.node` binary. That binary **cannot run on Cloudflare Workers** (no native modules, no filesystem, 128 MB isolate). The seed's core claim holds: the local inference path is dead on Workers.
- **Output**: 384-d L2-normalized, mean-pooled; `EMBED_DIMS = 384` enforced by an assertion in `embedText()` (`lib/substrate/memory/embed.ts:15-17, 76-78`).
- **Consumers of the same embedding space**:
  - Growth Memory: `lib/substrate/memory/{write,recall,consolidate}.ts` — facts stored with `vector(384)` pgvector columns (`GraphNode.embedding`, `MemoryFact.embedding`, `MemoryLearning.embedding` per schema lines ~6914/6956/6985 — `Unsupported("vector(384)")`, written via raw SQL); recall does pgvector/cosine + cross-encoder rerank + MMR + recency.
  - Corpus: `lib/intelligence/corpus/{embed,ingest,store,retrieve}.ts` — same `embedCorpusText()` → identical space ("keeps future cross-corpus fusion trivial" per `lib/intelligence/corpus/embed.ts` header). Chunks stored in `data/corpus/{main,by-sa}/chunks.jsonl` with embeddings rounded to 4 decimals (store.ts:58); corpus manifest **v9, 339 sources, 5,924 chunks**. Corpus retrieval is brute-force cosine over the loaded JSONL (no rerank in corpus path today — rerank is Growth-Memory-recall only, see §4).
  - Possibly also `internal-links` cron (link-graph similarity) — not fully verified; audit before migration.
- **Design invariant**: both Growth Memory and corpus share ONE embedding space. Any replacement must replace the embedder for *both* (or explicitly keep them aligned).

### Why dims alone don't save you

`@cf/baai/bge-small-en-v1.5` (Workers AI) is **also 384-d** — same dimension, *different embedding space*. Vectors from MiniLM and bge-small are NOT comparable (cosine across models is meaningless). So even with dims preserved, **all 5,924 corpus embeddings + every pgvector row in GraphNode/MemoryFact/MemoryLearning must be re-embedded** with the new model before queries and documents can be compared. A dims change (e.g. bge-base 768) additionally requires `vector(384)` → `vector(768)` column migration (pgvector: `ALTER COLUMN TYPE vector(768)` fails on non-empty columns without rewrite; standard approach is add-new-column, backfill, drop-old, rename — or recreate the index).

### Option (a): Workers AI embeddings

- **Model**: `@cf/baai/bge-small-en-v1.5` — 384 dims, 512 max input tokens, batch-capable (array input). **$0.020 per M input tokens** (1841 neurons/M) — official Workers AI pricing page, UNVERIFIED snapshot from 2026-09-27 web search. Rate limit 3000 req/min.
- Pros: dims preserved (384 — no `vector(384)` column migration needed, only re-embedding); trivially callable from Workers via `env.AI.run(...)`; batching; effectively zero infra to run; pennies: a full corpus re-embed (~5,924 chunks × ~200 tokens ≈ 1.2M tokens) costs **~$0.03**; ongoing write-path cost is noise.
- Cons: **embedding space changes** (MiniLM → bge-small) — re-embed everything + re-derive/re-verify any hand-tuned cosine thresholds (the ingest/eval battery has nDCG checks — `retrieve.ts` comment mentions an "nDCG battery" for the rerank path; corpus eval `scripts/eval-corpus.mts` + `data/corpus/eval-results.json` baseline exists to measure drift). 512-token input cap vs current 4000-char slice (~1000 tokens) — long chunks get truncated differently; re-chunking policy should be decided before re-embed. Workers AI is a runtime dependency on Cloudflare's GPU capacity (rate limits are per-minute; backfill bursts need pacing). Text leaves the tenant's DB to Cloudflare's AI service — acceptable under the current posture (already calls LLMs), but note for ZDR-sensitive tenants.
- Migration path: (1) swap `embedCorpusText`/`embedText` behind the same interface to call `env.AI.run` (needs `env` threading — today these are plain functions; the call sites in Next route handlers can pass env, but a clean cut is an adapter in `lib/llm` — the documented DEVIATION in `lib/intelligence/corpus/embed.ts` says exactly this: "If a remote embeddings provider is ever added to lib/llm, it can be swapped in behind embedCorpusText() without touching callers"); (2) run one backfill job re-embedding all 5,924 chunks + pgvector rows, writing new vectors into the same `vector(384)` columns (dims unchanged); (3) re-run `scripts/eval-corpus.mts` + the memory nDCG battery and diff against baselines before flipping reads; (4) blue/green: write both, read old, compare, flip.

### Option (b): external embedding API (OpenAI / Cohere / etc.)

- Cost reference (UNVERIFIED — from a 2026 community skill doc): OpenAI `text-embedding-3-small` 1536-d, `text-embedding-3-large` 3072-d; Cohere `embed-english-v3.0` 1024-d. 1536/1024/3072 dims all ≠ 384 → **mandatory `vector(384)` column migration** (add/drop/rewrite on every pgvector table) plus full re-embed, plus every hand-tuned cosine threshold re-derived.
- Pros: model choice/quality control; same provider as the LLM tier could simplify key management; no CF lock-in.
- Cons: dims mismatch makes this the most invasive option (schema migration + re-embed + threshold re-derivation); recurring per-token cost is still trivial at this scale but it's a new external dependency with its own latency on the recall path (recall does a query-embed per retrieval — today that's local/sub-ms-ish after warmup; an API call adds 100–500ms per recall). Cohere also sells a rerank API (see §4).
- Migration path: same as (a) but with the added column migration; strictly more work than (a).

### Option (c): precompute-at-write in a container (small embedding service on VPS)

- Shape: keep `Xenova/all-MiniLM-L6-v2` **exactly** — run a tiny HTTP service (FastAPI/Node) on the existing VPS/container host exposing `POST /embed` and `POST /rerank`; Workers call it over HTTP; **zero re-embedding, zero column migration, zero threshold re-derivation** — the embedding space never changes.
- Pros: **the only option with no data migration**; keeps the "no external API on the recall path" posture for the model itself (it's your box); model + thresholds + eval baselines all survive untouched; rerank (§4) solved by the same service for free; works from both the current Next host and Workers with no code-path divergence.
- Cons: you keep a box (the thing the migration is trying to shed) — a GPU-less CPU container runs MiniLM fine (ONNX CPU, ~50-100ms per embed, cross-encoder ~100-300ms per pair-batch); it becomes a single point of failure on the recall path (recall is currently synchronous per query) — needs health checks + the existing honest-error behavior (`MemoryModelError`, never silent degrade) maps to HTTP 5xx; adds network latency to every recall (edge → VPS round trip); auth between Worker and the service (shared secret / mTLS); cold-start of the model (~seconds) needs a warm standby.
- Migration path: (1) containerize the two functions from `lib/substrate/memory/embed.ts` into a service; (2) replace `embedText`/`crossEncoderScores` bodies with HTTP calls behind the same signatures (callers untouched); (3) no data work at all.

### Recommendation

**Primary: (a) Workers AI `@cf/baai/bge-small-en-v1.5`** — it is the rare case where the CF-native replacement preserves dims (384), so the migration is *re-embedding only*, no schema surgery, at ~$0.03 per full-corpus backfill. The eval harnesses already exist to quantify any quality drift (corpus eval + memory nDCG battery) before flipping reads.

**Fallback/bridge: (c) container embedding service** — if the eval diff shows unacceptable quality loss from the MiniLM→bge-small space change, or if Tico wants zero data churn during the cutover, (c) buys time with literally no data migration. It can also serve as the *backfill worker* for option (a): keep serving MiniLM from the container while Workers AI re-embeds in the background, then flip.

**(b) is not recommended** unless there's a quality case for 1536/3072-d embeddings that justifies a full `vector(384)` column migration plus threshold re-derivation — nothing in the current thresholds suggests 384-d is the binding constraint on quality (the rerank step, §4, is the quality lever).

Open questions for the coordinator: (1) is `vector(384)` used anywhere else (pgvector indexes on GraphNode/MemoryFact/MemoryLearning — confirm the full list of `vector(` columns); (2) hand-tuned cosine thresholds inventory (clustering/dedup constants) that need re-derivation on a space change; (3) `internal-links` cron's similarity source — verify it uses the same embedder before assuming the two-consumer list is complete.

---

## 4. CROSS-ENCODER RERANK — same treatment

**Current state**: `crossEncoderScores()` in `lib/substrate/memory/embed.ts` — local `Xenova/ms-marco-MiniLM-L-6-v2` via the same `@xenova/transformers` + onnxruntime-node native binding. Used **only in Growth Memory recall** (`lib/substrate/memory/recall.ts:239-248`): after fused vector+keyword retrieval, reranks the candidate pool in chunks of 16, then MMR + recency. Corpus retrieval (`lib/intelligence/corpus/retrieve.ts`) does **not** rerank today (brute-force cosine top-k). Warmup: `warmMemoryModels()` loads both models eagerly. Same honest-error contract: `MemoryModelError` on load failure, never silent degrade.

**Workers AI has a native answer**: `@cf/baai/bge-reranker-base` (shipped since March 2025 per community docs, UNVERIFIED date), exposed via `env.AI.run` and via the `ai` SDK's `rerank()` helper; **283 neurons / M input tokens** (UNVERIFIED pricing snapshot) — cheaper than any embedding model. This is a **drop-in semantic replacement**: rerank scores are only ever compared *within one query's candidate pool* (relative ordering), never persisted, never compared across model versions — so unlike embeddings, **there is no data migration at all** for the rerank step. Swap the function body, re-run the nDCG battery, done.

- With option (a) [Workers AI embeddings]: rerank via `@cf/baai/bge-reranker-base` — consistent story, one provider, no infra. Note: scores are raw relevance logits, not calibrated across models — any absolute score thresholds in recall (e.g. "honesty gate: below threshold → retrieve nothing") must be re-derived against bge-reranker-base's score distribution.
- With option (b) [external embeddings]: Cohere `rerank-v3.5` is the paid alternative (community fallback-chain docs cite it as highest quality); same no-migration property.
- With option (c) [container service]: keep `ms-marco-MiniLM-L-6-v2` in the same container — zero behavior change, zero re-derivation.

**Recommendation**: same as §3 — Workers AI `@cf/baai/bge-reranker-base` under option (a); it rides along for free with the embedding choice and has no migration cost either way. The one task is re-deriving any absolute rerank-score thresholds against the new model's score scale.

---

## Open items / follow-ups for the coordinator

1. **Doc gaps** (§1): DEPLOY §3.8 crontab is missing schedules for `connector-refresh`, `nurture`, `messaging`, `workflows`, plus `calls/reminders/run` and `media/kill-rules/evaluate`. Complete the table before writing `wrangler.toml [triggers]`.
2. **Alert digest race** (§2a #4): needs an atomic claim on `alertRule` before any multi-consumer deployment.
3. **Mission chain fork guard** (§2b): consider unique `(missionId, prevHash)` or per-mission serialization if queue consumers ever append concurrently.
4. **Timezone audit** (§1 watch-out #3): host crontab runs in server TZ; CF cron is UTC.
5. **Embedding inventory**: confirm full list of `vector(` columns and hand-tuned cosine thresholds; verify `internal-links` cron's similarity source.
6. All Cloudflare numbers above are UNVERIFIED (web research 2026-09-27, secondary sources). Re-verify against `developers.cloudflare.com` before committing to limits in the plan.

*End of Worker 4 report.*
