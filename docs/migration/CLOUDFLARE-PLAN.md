# Marketr → Cloudflare: Migration Plan

**Date:** 2026-09-27 · **Status:** PLANNING ONLY — research, no code changed, nothing migrated, nothing pushed
**Decision:** Tico approved the full Cloudflare move (+ R2 storage) on 2026-09-27. Wave A must land first — this plan assumes the tree is frozen at the Wave A commit.
**Research:** 5 parallel read-only workers; scratch detail in `docs/migration/scratch/w1-compat.md` … `w5-platform.md`.
**Honesty rule:** verified against code and current (2026) public docs; `UNVERIFIED` where unconfirmed.

---

## 0. The one-page verdict

**Marketr cannot run as a pure Workers-isolates app.** Too much of it needs real Node compute: `sharp` (server PNG render, QR), onnxruntime (MiniLM embeddings), `child_process` (corpus rebuild spawn, `pdftotext`, `ffmpeg`/`ffprobe`), filesystem writes (`.data/` trees, working copies), and a native Prisma engine. The honest target is a **hybrid**:

| Layer | Today (VM) | Target |
|---|---|---|
| App shell + edge-safe API routes | Next.js standalone on VM | Cloudflare Workers via `@opennextjs/cloudflare` |
| Postgres | Durable PG 16, port 5433 | **Neon** (pinned PG16, pgvector 0.8.0, pg_trgm 1.6) via `@prisma/adapter-neon` (WebSocket) |
| Prisma connection | Bare `new PrismaClient()`, direct TCP | Driver adapter → Neon `-pooler` endpoint; `SET LOCAL` RLS survives (transaction-pinned, fail-closed preserved) |
| Files/media | `.data/` on disk, hand-rolled S3 adapter | **R2** — the S3-compatible adapter already exists (`MARKETR_STORAGE=s3`); ~95% config-only |
| Images | `sharp` on VM | **Keep sharp on Node compute** (Containers or residual VPS); outputs → R2; delivery via Cloudflare Images CDN |
| Embeddings | onnxruntime MiniLM 384-d (local) | **Workers AI `@cf/baai/bge-small-en-v1.5`** (also 384-d → re-embed only, no schema surgery, ~$0.03/corpus backfill) |
| Rerank | local cross-encoder | **Workers AI `@cf/baai/bge-reranker-base`** (zero data migration — scores never persisted) |
| Cron (25 routes) | host crontab | Cron Triggers → enqueue-and-return; 9 long sweeps fan out via Queues; 30s-poll route uses delayed requeue |
| Queues | DB-backed atomic-claim polling | Cloudflare Queues (atomic-claim rows stay as source of truth; CF adds transport + DLQ) |
| Payload CMS | In-app mount | **Stays on residual VPS** (isolated island; nothing in-app consumes it); admin on tunneled subdomain |
| Sidecars | Docker on VM | **One residual VPS** + Cloudflare Tunnel; GrowthBook → Cloud Starter free, Umami → CF Web Analytics ($0) |
| White-label domains | Schema-ready, DNS out of scope | Cloudflare for SaaS custom hostnames (100 free, $0.10/mo beyond) |
| **Steady-state cost** | current bill UNVERIFIED | **~$100–195/mo**, dominated by always-on Neon compute (~$85–165) |

**Hyperdrive is REJECTED for tenant paths** — Cloudflare documents `SET` as unsupported through it, and tenant isolation *is* `SET LOCAL app.workspace_id`. Not negotiable.

---

## 1. Workers-compatibility audit (from `w1-compat.md`)

### BLOCKER — cannot run on Workers isolates, must be replaced or offloaded

| Area | Files | Remediation |
|---|---|---|
| `sharp` PNG render | `lib/design/render-server.ts:32`, `lib/media/qr.ts:19` | Keep on Node compute (Containers/VPS); outputs → R2; serve via CF Images CDN. W3 verified the render API is sharp/libvips, not node-canvas or headless Chromium. |
| onnxruntime embeddings | `lib/substrate/memory/embed.ts:9` (+ `os.tmpdir` model cache, 2 models) | Workers AI (see §5) or container embedding service. Also feeds corpus ingest chain. |
| Prisma native engine | ~150 files via `lib/prisma.ts:4` | `@prisma/adapter-neon` WebSocket (see §2). |
| `child_process` | `app/api/corpus/rebuild/route.ts` (spawn npx tsx), `lib/intelligence/corpus/ingest.ts` (execFileSync `pdftotext`), `lib/flywheel/ctv/validator.ts` (ffmpeg/ffprobe) | Queue consumers / Workflows; pdftotext → WASM PDF extraction or container; ffmpeg → container lane. |
| fs writes | `lib/filesystem/storage.ts` (LocalDiskAdapter), `lib/scheduler/outputStore.ts`, `lib/audit/runner.ts` (snapshots), `app/api/websites/[id]/route.ts` (working copies), 2 logo routes, corpus rebuild log, `lib/pdf/generate.ts` | R2 via the existing adapter; working copies need a LIST-capable provider (§3). |
| `node:sqlite` | `lib/intelligence/difficulty/authority.ts` (read-only CC-graph lookup) | Precompute → D1/KV, or drop the adapter (it already degrades gracefully). |
| 300s `maxDuration` + ffmpeg | `app/api/flywheel/ctv/creative/validate/route.ts` | Container lane (§4). |

### WORKAROUND — fixable with code/config changes

- **takumi-pdf**: ships a `workerd` export (WASM) — OpenNext must resolve the `workerd` condition; drop the `serverExternalPackages` hack.
- **ssh2 SFTP** (`lib/sitefiles/sftp.ts`): pure JS but raw TCP — move to container or keep VM-only.
- **15 routes with `runtime = "nodejs"`** (listmonk ×6, postiz ×4, webhooks, links, render): most are plain fetch/DB handlers — remove the pin after per-route check. The render route stays BLOCKER.
- **In-memory rate limiter** (`lib/api/rate-limit.ts` Map): per-isolate, not global → move buckets to KV or a Durable Object.
- **`node:dns` SSRF guard** (`lib/safe-url.ts`): `lookup()` not in the compat surface as used — replace with proxy-egress or accept platform networking (UNVERIFIED exact subset).
- **ClamAV daemon** (`lib/security/malware-scan.ts`): unreachable from Workers → NoOp at edge or scan in queue consumer.
- **Payload pg → Neon**: needs a reachable DB; disable Payload telemetry (fs reads at init).
- **next.config**: `output: "standalone"` + `withPayload` + `outputFileTracingIncludes` are standalone-trace concerns — branch config per target (UNVERIFIED: `withPayload` under OpenNext).
- **Sync/fleet/orchestrator/missions engines**: long wall-clock (LLM steps, polite fetchers) → Cloudflare Workflows or queue-chained steps with state in D1/Neon.

### FINE — works as-is or via `nodejs_compat`

Zero WebSocket usage in the codebase (verified — collaboration is client-side only). `node:crypto`/`path`/`url`/`os`/`util`/`zlib`/`readline` imports are compat-covered. `@imgly/background-removal` is browser-only. `next/font` + `@fontsource` are build-time. No `instrumentation.ts`.

---

## 2. Data layer (from `w2-data.md`)

**Recommendation: `@prisma/adapter-neon` (WebSocket variant) → Neon pooled endpoint. Stay on Prisma 6.19.3. Hyperdrive rejected. Accelerate rejected.**

### Neon (verified against official docs 2026-09-27)

| Feature | Local | Neon (PG16 project) |
|---|---|---|
| pgvector | 0.6.2 | **0.8.0** (0.8.6 on PG18) — pin project to **PG16** to minimize skew |
| pg_trgm / pgcrypto | 1.6 / 1.3 | **1.6 / 1.3** — exact match |
| HNSW cosine (`m=16, ef_construction=64`) | in use | Fully supported; DDL transfers verbatim |
| `<->` / `<=>`, `ts_rank`, trigram `%` | in use (122 raw-SQL sites audited) | All safe |
| `CREATE EXTENSION` as non-superuser | migrations use `IF NOT EXISTS` | Works for project owner; migrations replay idempotently |

**pgvector 0.6.2 → 0.8.0: LOW risk.** Operator/index DDL unchanged; logical dump/restore absorbs the 0.6.0 TOAST change; no re-embedding needed. Acceptance: recall-parity diff vs 0.6.2 baseline + one `REINDEX` of the three HNSW indexes.

**Branching → preview DBs:** instant copy-on-write branches with own pooled+direct endpoints → per-PR/per-environment preview databases, migrated per branch, deleted on merge. Branch compute scales to zero (first query after suspend may need one client retry).

### Why not Hyperdrive / Accelerate / direct pg

- **Hyperdrive ❌**: Cloudflare lists `SET` as unsupported through it; tenant isolation is `SET LOCAL app.workspace_id`. Its query cache is keyed on query text, not the tenant GUC — a cross-tenant leak hazard for RLS reads. Disqualifying on both counts.
- **Accelerate ❌**: viable but adds vendor, bill, and cache semantics for a DB that already ships its own pooler.
- **`@prisma/adapter-pg` direct TCP ❌**: reintroduces connection exhaustion; strictly worse than the Neon-native adapter.

### RLS-through-pooling: ✅ SAFE

`withWorkspaceScope()` = `$transaction` + `SET LOCAL app.workspace_id`. `SET LOCAL` is transaction-scoped; through PgBouncer **transaction** pooling the connection is pinned for the transaction, so no GUC leakage. FORCE RLS degrades closed (zero rows) on any failure — the failure mode is *no data*, never *wrong tenant's data*. **Must re-run the RLS battery against the exact pooled endpoint before cutover.**

### File-level change list

1. `package.json`: add `@prisma/adapter-neon`, `@neondatabase/serverless` (no Prisma version change).
2. `lib/prisma.ts`: `new PrismaClient({ adapter: new PrismaNeon({ connectionString }) })` — decide per-request vs module-scope construction (community reports "Cannot perform I/O on behalf of a different request" with cached WS pools; UNVERIFIED — load-test both).
3. `prisma/schema.prisma`: add `directUrl = env("DIRECT_URL")` for CI `migrate deploy`; keep `url`.
4. `prisma.config.ts`: CLI resolves the direct (non-pooled) Neon endpoint.
5. `lib/substrate/memory/consolidate.ts` (`workerPrisma`): pool sizing moves from URL param to neon Pool options; keep `MEMORY_WORKER_ROLE` → Neon role.
6. Env split: `DATABASE_URL` (pooled, runtime) + `DIRECT_URL` (direct, migrations), per branch.
7. New CI job: `prisma migrate deploy` per branch, gating preview deploys.
8. RLS battery re-run on the pooled endpoint (no logic change expected).
9. `lib/substrate/memory/recall.ts`: no change; recall-parity diff + REINDEX post-restore.
10. Old migrations (67): never edited; replay as-is.

**Do NOT bundle a Prisma 7 upgrade** — adapter cutover on 6.19.3 first, upgrade separately.

---

## 3. Storage: R2 + Images (from `w3-storage-images.md`)

### The good news: 95% is config, not code

`lib/filesystem/storage.ts` already ships a real `S3CompatibleAdapter` + `FileManagerService` wrapper. The switch is **environment, not engineering**:

```bash
MARKETR_STORAGE=s3
MARKETR_S3_ENDPOINT=<account>.r2.cloudflarestorage.com   # account-level R2 endpoint
MARKETR_S3_REGION=auto
MARKETR_S3_BUCKET=marketr-media
MARKETR_S3_ACCESS_KEY=<R2 API token key>
MARKETR_S3_SECRET=<R2 API token secret>
MARKETR_S3_FORCE_PATH_STYLE=true
MARKETR_S3_PREFIX=                              # optional bucket sub-prefix per env
```

Already covered by the adapter today: public upload APIs, FileManager UI, project briefs/attachments, generated artifacts (PNG/ZIP/txt/json), QR downloads, PDF exports, scheduler artifacts, report PDFs, logos/favicons, sitemap archives, `.data/` subtrees, fix-agent snapshots.

### Exceptions needing real work

| Item | Today | Target |
|---|---|---|
| Public URLs / downloads | Signed with local disk path | Signed URLs via the S3-compatible signer (R2), **or** a rewrite to custom public-domain URLs; legacy LocalDisk adapter can dual-read during transition |
| `.data/sites/<id>/working` (site IDE) | Path-tree semantics, atomic deploy, `listRecursive` | R2 via `listV2` + delimiters; **UNVERIFIED**: atomicity boundary differs from POSIX — verify the deploy step's expectations before cutover |
| `lib/pdf/generate.ts` (takumi) | Writes PDF to disk | Keep on Node compute; output buffer → upload to R2 |
| `app/api/design/render` | Reads JSON from disk | Accept multipart/FormData (or fetch from R2 by key) instead of disk reads |
| Payload CMS media | `public/media/` local storage | Payload S3-storage plugin pointed at R2 + `disableLocalStorage` (config only; Payload stays on the VPS per §7) |
| Upload proxy pattern | `copyFile(tmp, storage)` | Accept Buffer/File directly from multipart — avoids temp disk entirely |

### R2 details (verified)

- Account-level endpoint `<account_id>.r2.cloudflarestorage.com`; `MARKETR_S3_REGION=auto`, path-style on.
- Key format: `s3://marketr-media/<projectId>/<userId>/<hash>.png` — no rename needed; flat namespace, `/` is convention only.
- **Zero egress fees** to Workers/the web. Class A $4.50/M, Class B $0.36/M ops; storage $0.015/GB-mo.
- CORS rule needed for direct browser uploads (if used).
- Custom domain on bucket → presigned URLs become `cdn.marketcrm.com/<key>`.
- **Backfill:** `aws s3 sync` with `--endpoint-url` + R2 token, or one Node script through the FileManagerService that enumerates local `.data/` and uploads (writes the R2 key back to the DB row; keep the DB column as the source of truth, not the filesystem).

### Cloudflare Images (delivery, not rendering)

Cloudflare Images delivers and transforms *raster* images (resize/crop/AVIF-WebP), served off `MARKETR_IMAGES_DELIVERY_URL`. It **cannot** replace the server-side JSON→PNG renderer (`sharp`, custom SVG, private fonts) or styled-QR rasterization — those stay on Node compute; their outputs upload to R2, and Images delivers them. No `next/image` usage exists, so nothing is coupled to Vercel's image optimizer. Recommendation: Images for any *public, cacheable, high-traffic* image; direct R2 for *private/tenant-scoped* assets.

### Open questions before cutover

- The exact S3 adapter implementation (signed URLs, HEAD/conditional writes) must be exercised **against real R2** — one smoke test script, not assumptions.
- R2 custom-domain + presigned-URL interplay needs one live check.
- `MARKETR_PUBLIC_URL` behavior under the S3 path needs review.

---

## 4. Cron, queues, embeddings, AI (from `w4-cron-queues-ai.md`)

### 25 cron routes → Cloudflare Cron Triggers

| Pattern | Routes | Target |
|---|---|---|
| Sweeps (short) | alerts, briefs, digest, scheduler, missions/run, growth-memory/consolidate, social listening, sync, link-monitoring, serp-tracking, rank-tracking, sitemap, ai-usage, email-monitor, sync-maintenance, sync-reconcile | Cron Trigger → claim-due-units → enqueue work → return fast. |
| **Long jobs (fan-out required)** | fix-agent, platform-radar, radar, decay, fleet, local-grid, autopilot, visibility-score, backlinks | Trigger claims units, enqueues unit-IDs (not payloads), queue consumers process one unit each. DB atomic claims stay the source of truth. |
| 30s poller | `/api/cron/ads` | **Broken by CF's 1-minute minimum.** Use a delayed Queue message / Workflow sleep chain. |
| User-defined cron strings | scheduled-skill engine | CF runs one frequent trigger; Marketr's own scheduler keeps evaluating user cron expressions (existing design stays). |

**Timezone:** CF cron is UTC — audit any route assuming server-local time.

### Concurrency hazards to fix before the queue era

1. **Alert digest race** (`lib/monitoring/alerts.ts`): two sweeps can double-create a digest → add atomic `INSERT ... ON CONFLICT DO NOTHING` claim row first.
2. **Mission audit hash chain** (`lib/orchestrator/missions.ts`): concurrent audit appends fork the chain → per-mission serialization or unique append index.
3. CF Queues are **at-least-once and unordered** → every consumer rechecks state and is idempotent by construction.
4. Existing DB advisory locks / `skipLocked` remain the correctness backbone; CF Queues add transport + dead-letter, not ordering.

### Embeddings → Workers AI: the cleanest migration in the plan

| | Today | Target |
|---|---|---|
| Embedding | `Xenova/all-MiniLM-L6-v2`, 384-d, onnxruntime | **`@cf/baai/bge-small-en-v1.5`**, **384-d** |
| Reranker | `Xenova/ms-marco-MiniLM-L-6-v2` | **`@cf/baai/bge-reranker-base`** |

Same dimensionality → **no schema migration** (`vector(384)` stands). But the embedding *space* changes, so this is a re-embed, not a swap:

1. Keep MiniLM reads live. Add the Workers AI provider behind the existing `EmbeddingProvider` interface.
2. Backfill bge vectors (corpus 5,924 chunks ≈ **~$0.03** at current Workers AI pricing — **UNVERIFIED**, recheck at build).
3. Re-embed Growth Memory vectors (same scale assumption — measure the row count; pricing unverified).
4. Re-run corpus eval + memory nDCG/recall; re-tune hybrid weighting + reranker thresholds.
5. **Flip reads only if quality ≥ baseline.** Keep the MiniLM container as rollback (it keeps serving until reads flip).

The reranker is risk-free: scores are never persisted. `@cf/baai/bge-reranker-base` is one of the two rerank models Workers AI supports and scores query↔document pairs directly.

**Container fallback is cheap insurance:** MiniLM is ONNX-only, no GPU needed — a tiny box/container reuses the *existing* embedding code unmodified as a bridge/rollback.

---

## 5. Payload CMS (from `w5-platform.md`) — **KEEP ON THE VPS (option a)**

Verified in-tree: Payload v3.90.2 mounted at `app/(payload)/{admin,cms-api}`, schema `payload`, `push: true`; **nothing in Marketr's app code consumes it** — no `getPayload` calls, no `/cms-api` fetches outside Payload's own admin. It's an isolated editorial island.

**Why not Workers:** GraphQL-on-Workers is not currently guaranteed (workerd#5175); known `pg.Pool` cross-request-context leak with Neon+autosuspend (payload#17335) — the exact failure mode of a low-traffic CMS; `push: true` must become real migrations first; Paid-plan bundle; two compat flags + IgnorePlugin wiring.

**Shape:** Payload container on the residual VPS (Node → Neon **direct** string, no edge constraints), admin on `cms.<domain>` via Cloudflare Tunnel (keeps HTTP-only session cookies off the Worker), Payload S3-storage plugin → R2 for media (`disableLocalStorage`), API-key auth over TLS for any server-side calls. Effort S, risk LOW. Revisit Workers later once the main app is stable; rebuild natively only if multi-tenant CMS becomes a product requirement.

---

## 6. Sidecars (from `w5-platform.md`) — **ONE RESIDUAL VPS + free-tier swaps**

| Sidecar | Target |
|---|---|
| Activepieces (MIT) | Docker on residual VPS; Worker calls REST over HTTPS |
| Listmonk (AGPL-3) | Docker + own DB on VPS (Go, light; no managed offering) |
| Postiz (AGPL-3) | Docker on VPS ($29/mo Cloud rejected — VPS share wins) |
| GrowthBook | → **Cloud Starter FREE** (container killed) |
| Umami | → **Cloudflare Web Analytics FREE** (container killed) |
| Chatwoot / Plane / Documenso | Stay BYO-external (no change) |
| Embedding fallback + sharp/ffmpeg/takumi rendering lane | Small container(s) on the residual VPS as bridge/rollback |

**Connectivity:** Workers can't reach private IPs → **Cloudflare Tunnel** (`cloudflared`) on the VPS exposes sidecar APIs as HTTPS on the zone; no open ports, no public IPv4. Service-token/mTLS auth on every Worker→sidecar call. Keep the VPS in US-East (e.g. DO NYC 2 vCPU/4 GB $24/mo, or Hetzner US CPX ~$20/mo) to match the tenant base. **Hetzner 2026 prices are volatile (repriced twice); verify at order time.**

### Recommended long-term platform stack

- **Workers (Paid) + `@opennextjs/cloudflare`:** the globally-distributed request layer — one edge fleet, no app servers to provision.
- **Neon (PG16):** relational + vector data plane, branching for previews, PITR.
- **R2:** all durable files/media/corpus — no local disk, no egress fees.
- **Cloudflare Images:** optimized delivery of public images.
- **Queues / Cron Triggers / Workflows:** durable background orchestration.
- **Workers AI:** embeddings + reranking (metered, cents-scale at current volume).
- **Cloudflare for SaaS:** white-label domains as an API, not a ticket.
- **One residual VPS/container pool:** Payload, sidecars, sharp/ffmpeg/PDF jobs, SFTP, embedding bridge.
- **Why this scales:** stateless HTTP scales without app servers; R2 removes disk coupling; Neon separates storage from compute; Queues absorb spikes and protect provider rate limits; slow/native work scales *separately* from the request layer; white-label certs become API-driven. Each expensive subsystem scales on its own curve instead of one monolithic VM.

---

## 7. White-label domains: Cloudflare for SaaS (from `w5-platform.md`)

Today's state: `white_label_custom_domain` is schema-ready; the UI validates format only — *"DNS provisioning is out of scope"*. This section is the missing half.

### Provisioning flow (verified against 3 independent 2026 sources)

1. **Fallback origin (one-time):** in the SaaS zone, create an originless proxied record (e.g. `AAAA 100::` on a fallback host) + Worker route. Customer traffic lands in the zone and hits the Worker.
2. **Per tenant:** `POST /zones/{zone_id}/custom_hostnames {hostname: "reviews.acme.com", ssl: {method: "http", type: "dv"}}` → show the CNAME target in the UI.
3. **Customer DNS:** one CNAME at their provider (TXT for delegated DCV). Poll `status` (hostname) **and** `ssl.status` (cert) until both are `active` — only then mark the domain live.
4. **Request routing:** the Worker reads the `Host` header → looks up `white_label_custom_domain` → workspace (Neon/KV read, short KV cache) → serves that tenant's branding/theme. One Worker serves the SaaS zone *and* all custom hostnames — no per-tenant deploys.
5. **Removal:** `DELETE /custom_hostnames/{id}`; keep the DB row 7 days (reversible cooldown) before purge.
6. **Apex limitation:** apexes can't CNAME at most registrars; CF Apex Proxying is Enterprise-only. Self-serve: support `www.` + redirect; document apex as registrar-dependent (ALIAS/ANAME/CNAME-flattening).

**Pricing:** first **100 custom hostnames free**, then **$0.10/hostname/mo** (metered; self-serve ceiling 50,000). **UNVERIFIED:** whether the 100-free quota applies on Free/Pro or requires Business ($200/mo) — sources conflict. **Verify with Cloudflare before quoting customers.** Per-workspace hostname quota (e.g. 1 free / N paid) is the standard way to bound this cost — pairs with Wave A's billing work.

---

## 8. Phased cutover (from `w5-platform.md`, w2)

**Entry rule for the whole program:** tree frozen at the Wave A commit. No phase moves production traffic before its soak passes. Every phase has an instant rollback.

### Phase 0 — Foundations & baselines (S)

- Provision Cloudflare account + zone, Neon project (PG16, US region), residual VPS, test Cloudflare Tunnel.
- Record baselines: req/min, p50/p95 latencies, DB size, corpus chunk/vector counts, sidecar RAM/disk use.
- **Entry:** decision log approved (Payload option (a), `@prisma/adapter-neon` WS, VPS shape, no Hyperdrive).
- **Exit:** accounts live, baselines recorded, tunnel reaches VPS. **Rollback:** n/a — nothing live.

### Phase 1 — Data plane to Neon, app still on the VM (M)

- Logical `pg_dump`/`pg_restore` (public + `payload` schemas; **never physical copies**) to a Neon branch → rehearse → restore to main; enable extensions; replay all 67 migrations; `REINDEX` the 3 HNSW indexes.
- Run the acceptance battery: hybrid-recall parity vs 0.6.2 baseline, RLS cross-workspace negative tests (zero-row fail-closed proof), extension/extensions parity.
- Point the **VM app** at Neon (Node → Rust engine → direct TCP; no adapter needed on the VM yet). Soak.
- **Rollback:** `DATABASE_URL` back to the VM PG (one env change + restart). Keep the VM PG as hot standby until soak passes.

### Phase 2 — Prisma edge adaptation on the VM (S)

- Add `@prisma/adapter-neon` (WebSocket variant — **not** HTTP; the RLS layer needs callback-form interactive transactions) behind an env flag.
- Full RLS + transaction battery against the `-pooler` endpoint; decide per-request vs module-scope client construction from load-test results (the cross-request I/O concern is **UNVERIFIED**).
- **Exit:** adapter path green on all tests. Purpose: de-risk Phase 4 without moving traffic. **Rollback:** flag off — standard client remains.

### Phase 3 — R2 + residual services (M)

- Flip `MARKETR_STORAGE=s3` to R2; backfill `.data/` (script through FileManagerService; DB row = source of truth); exercise signed URLs + the disk-delegate path against real R2.
- Payload + sidecars + rendering-lane containers to the residual VPS; admin on `cms.<domain>` via Tunnel; GrowthBook → Cloud Starter, Umami → CF Web Analytics.
- **Rollback:** dual-read/retain local storage; keep the old compose stack up until the soak passes.

### Phase 4 — Workers compatibility split (L)

- Build with `@opennextjs/cloudflare`; staging on `*.workers.dev`; full route smoke (626 routes); white-label provisioning end-to-end; load soak on the budget line.
- Route native/long-running handlers to the container lane; flip embeddings to Workers AI (dual-write first); enable the env-flagged adapter from Phase 2.
- The entire current VM stack keeps serving prod until DNS flips.
- **Rollback:** DNS back to the VM origin (minutes).

### Phase 5 — White-label domains + traffic cutover (S/M)

- Custom-hostname automation live; canary on an internal workspace, then selected tenants; monitor before increasing traffic.
- **Rollback:** Worker/fallback-origin routing back to the VM.

### Phase 6 — Soak and VM retirement (S)

- Retain backups + rollback origin through a defined soak period. Retire **only the old application VM** — the residual VPS (sidecars/Payload/native lane) stays permanently.
- No destructive shutdown until logs, billing, queues, RLS, file delivery, and tenant routing all pass acceptance. No hour promises — phases move on exit criteria, not calendars.

---

## 9. Cost model (from `w5-platform.md`, checked 2026-09-27)

**All prices public and current as of the research date; Hetzner/Neon have repriced within the last year — recheck before ordering. Current VM spend is UNVERIFIED (not found in research) — treat any "cheaper than today" claim as unproven until someone reads the current bill.**

| Line | Est. USD/mo | Note |
|---|---|---|
| Workers Paid | $5 | Incl. 10M requests + 30M CPU-ms; overage $0.30/M req, $0.02/M CPU-ms |
| Neon Launch (steady 1–2 CU) | **~$85–165** (UNVERIFIED estimate) | $0.106/CU-hr + $0.35/GB-mo; no monthly minimums since Dec 2025. **Scale-to-zero does not save a live SaaS** — budget always-on; bursty dev branches do scale to zero. |
| R2 (media) | $0–2 | $0.015/GB-mo, Class A $4.50/M ops; **$0 egress** |
| Images | $0+ | ~$5/100K stored + $1/100K transforms; scales with usage |
| Workers AI / Queues | $0+ | Metered, cents-scale at current volume (corpus re-embed ≈ $0.03; recheck pricing at build) |
| Residual VPS | $10–24 | DO Basic 2/4 GB $24 (US); Hetzner CX33 ~$10 EU / CPX11 ~$20 US (volatile — verify) |
| for-SaaS hostnames | $0 → $0.10/hostname/mo | 100 free first (plan-gating UNVERIFIED) |
| GrowthBook / Umami | $0 | Cloud Starter free / CF Web Analytics free |
| Hyperdrive | $0 | **Not used on tenant paths** (rejected — §2) |
| **Steady-state total** | **~$100–195/mo** | Before request overages; Neon is ~80% of it |

**The structural story, not the bill:** cost shifts from fixed VM rent to metered compute — Neon compute for an always-on workload is the dominant line and grows linearly with utilization while VPS rent doesn't. The real win isn't cheaper dollars, it's *shape*: unbundled scaling curves (request layer, data, storage, background work each scale on their own), global edge latency, zero-egress storage, API-driven white-label domains, and preview databases that cost nothing when idle.

---

## 10. Top 5 blockers

1. **Prisma native engine can't run on Workers** → `@prisma/adapter-neon` (WebSocket) behind an env flag; RLS battery re-run on the `-pooler` endpoint; never bundle a Prisma 7 upgrade.
2. **Local MiniLM + onnxruntime can't run on Workers** → Workers AI `@cf/baai/bge-small-en-v1.5` (384-d, same dims → re-embed only, ~$0.03/corpus); `@cf/baai/bge-reranker-base` for rerank; flip reads only after eval ≥ baseline; keep a MiniLM container as rollback.
3. **`sharp` / ffmpeg / `pdftotext` / `child_process`** → stay on Node compute (container lane on the residual VPS or Cloudflare Containers); Cloudflare Images handles delivery, never rendering.
4. **`.data/` path-tree semantics** (site IDE working copies) → R2 `listV2` + delimiters; verify the atomic-deploy expectation against real R2 before cutover; dual-read locally during transition.
5. **Connection hygiene + request-context I/O on isolates** → per-request vs cached client construction is UNVERIFIED; load-test both; Neon autosuspend + isolate reuse is the exact failure shape seen in Payload issue #17335 — this is why Payload stays on the VPS.

## 11. Verification battery (definition of done)

- **RLS:** full negative-test battery on the *pooled* Neon endpoint — zero-row fail-closed proof across workspaces; `SET LOCAL` survives transaction pooling.
- **Recall parity:** hybrid retrieval diff (pgvector 0.6.2 → 0.8.0) + corpus eval + memory nDCG/recall after the bge backfill; re-derived thresholds; reads flip only on ≥ baseline.
- **Routes:** all 626 route files smoke-tested on `*.workers.dev` staging; `maxDuration`/fetch limits respected; no edge request holds an LLM stream.
- **Files:** signed-URL lifecycle against real R2; backfill script counts match; legacy local adapter dual-reads green.
- **Queues:** at-least-once idempotency proven (double-delivery doesn't double-create digests/audit forks); DLQ alarms wired.
- **White-label:** full custom-hostname lifecycle (create → CNAME → both statuses `active` → serve → delete) on staging.
- **Rollback drills:** each phase's rollback executed once in rehearsal, not just documented.

## 12. Hosting & scaling, long-term (the answer to Tico's "what platforms benefit us")

The end-state isn't "Marketr on Cloudflare" — it's **Marketr on a platform where each subsystem scales on its own curve:**

- **Traffic:** the edge Worker fleet absorbs spikes with zero provisioning; no more sizing an app server for peak.
- **Data:** Neon separates storage from compute; read/write traffic grows CU-hours linearly while idle branches cost nothing; PITR + branching make staging environments nearly free.
- **Media & files:** R2 removes the disk bottleneck entirely and kills egress fees — the more tenants upload, the less the architecture cares.
- **Background work:** Queues + Workflows turn 25 crons into a durable job system with retries and DLQs; provider rate limits get protected by queue pacing instead of hope.
- **Intelligence:** Workers AI makes embeddings/rerank a metered API call at cents-scale instead of a pinned native process — and the container bridge keeps a rollback.
- **White-label:** custom hostnames become an API call + certificate instead of a manual DevOps ticket — this is what makes the agency tier ($199/mo) *operable*, not just sellable.
- **What never leaves the VPS:** Payload CMS, social-scheduler sidecars, Listmonk/Postiz, native rendering — the stateful and binary-dependent stuff. One small box, ~$10–24/mo, Cloudflare Tunnel for private access.

**Platforms that benefit us most, in order:** (1) **Cloudflare** — the request layer, storage, background jobs, AI, and custom domains on one meter; (2) **Neon** — serverless Postgres that branches like git; (3) **One residual VPS** — the pressure valve for everything the edge can't hold. Hyperdrive, Accelerate, and D1 are deliberately *not* in the stack: the tenant-isolation model forbids Hyperdrive, Accelerate adds vendor for nothing, and Postgres+pgo is the wrong shape for D1.

---

*Plan assembled 2026-09-27 from 5 read-only research workers (scratch in `docs/migration/scratch/`). NOT APPROVED FOR EXECUTION — do not start migration work until Tico approves this plan. Wave A lands first.*
