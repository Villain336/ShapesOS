# Marketr Cloudflare Migration Research — Worker 5: Payload + Sidecars + White-label Domains + Cost + Phases

- Repo: ~/workspace/marketr (READ-ONLY; never modified, no builds, no servers)
- Written: 2026-09-27 (Sun EDT)
- Status: IN PROGRESS — appended incrementally; do not treat as final until "STATUS: COMPLETE" line at bottom.
- Seed facts verified in-tree:
  - Payload CMS v3 (`@payloadcms/next` ^3.90.2, `@payloadcms/db-postgres`, `@payloadcms/richtext-lexical`) mounted in-app: `app/(payload)/admin`, `app/(payload)/cms-api`, `payload.config.ts` with `schemaName: "payload"` + `push: true`.
  - Sidecars w/ compose profiles: Activepieces (`docker/integrations/activepieces.yml`), Listmonk (`docker/integrations/listmonk.yml`), Postiz (`docker/integrations/postiz.yml`), GrowthBook (`docker/profiles/growthbook.yml`), Umami (`docker/profiles/umami.yml`). BYO/externally-hosted (no sidecar): Chatwoot, Plane, Documenso, Ghost.
  - White-label schema-ready: `white_label_logo_url`, `white_label_custom_domain`, `white_label_brand_color` on Workspace; route `app/api/workspaces/white-label/route.ts` validates domain format only — "DNS provisioning is out of scope".
  - Route surface: 626 `route.ts` files under `app/` (seed said 634; recount excluding node_modules = 626).

## §0 — Verdict summary (fill at end)

(TODO)

---

## §1 — Payload CMS v3 on Workers (research, 2026-09-27)

KEY FINDING: **Yes — officially.** Payload's README (checked ~2 weeks ago) advertises
one-click "Deploy on Cloudflare": Workers + R2 uploads + D1 database, via template
`payloadcms/payload/tree/main/templates/with-cloudflare-d1`.
Caveats from community deploys (Dec 2025):
- PayloadCMS v3.65.0+ required for Workers compat (we're on 3.90.2 — OK).
- Two compat flags: `expose_global_message_channel` (React 19 / Next 15) and `enable_weak_ref`.
- Webpack IgnorePlugin to exclude incompatible Node modules; GraphQL playground off in prod.
- **Paid Workers only** — bundle exceeds free plan size limits.
- DB migrations must be run separately before deploying the worker.
- Official template is D1-backed (SQLite); our adapter is `@payloadcms/db-postgres`.
  UNVERIFIED in this session: db-postgres on Workers via Neon + Hyperdrive — needs check.

## §2 — Cloudflare for SaaS custom hostnames (research, 2026-09-27)

Consensus across 3 independent 2026 writeups:
- Available on **all plans including Free** (bundled for non-Enterprise).
- Flow: designate a **fallback origin** in your zone (for Worker-based SaaS: originless
  proxied record + Worker route, e.g. `AAAA 100::`); per-customer custom hostname
  created via API (`POST /zones/{zone}/custom_hostnames`); customer adds one CNAME at
  their DNS to your CNAME target; Cloudflare auto-issues per-hostname DV cert (HTTP/TXT
  DCV validation). Worker sees original hostname in `Host` header → route to tenant
  by `Host:` header lookup (your code).
- TLS statuses to watch: `status` (hostname) and `ssl.status` (cert) → both `active`.
- Apex domains: CNAME impossible at most registrars; Cloudflare's Apex Proxying is an
  Enterprise add-on. Practical self-serve: support apex only via ALIAS/ANAME/flattening,
  otherwise steer to `www.` + redirect.
- Pricing: **first 100 custom hostnames free**; **$0.10 per additional hostname/month**
  (metered; self-serve ceiling 50,000 hostnames; Enterprise beyond). One 2026-04
  comparison table still lists $0.10/mo with Business = $200/mo (100 included) — the
  "was $2, now $0.10" reduction is reflected. Note: that same table claims Free/Pro
  don't officially get it, while two other 2026 writeups say available on all plans
  incl. Free with 100 free — TREAT PLAN-GATING AS UNVERIFIED; $0.10/hostname beyond
  100 is consistent everywhere.

---

## §1 (cont.) — Payload + Neon/db-postgres on Workers

New wrinkle found (2026-09-27): open issue payloadcms/payload#17335 —
"db-postgres on Cloudflare Workers: globally cached pg.Pool leaks promises across
request contexts and corrupts unrelated requests" (Neon + Hyperdrive, OpenNext).
Reproducible: after Neon autosuspend (~5 min idle), first burst of admin page loads
→ request hangs, force-cancelled, cross-context warning, subsequent unrelated admin
routes on the same isolate start failing. Mitigations: request-scoped pools (not
globally cached), `connectionTimeoutMillis`/`statement_timeout`/`query_timeout` —
these narrow the window, don't remove the mechanism. Prisma has the same open issue
(prisma/prisma#28732). Implication: db-postgres on Workers works, but connection
hygiene is a real operational risk — Neon + autosuspend + isolate reuse is the worst
combination.

## §3 — VPS pricing (research, 2026-09-27)

Hetzner Cloud (after 2026-06-15 repricing; EUR/mo, excl. VAT; +€0.50 IPv4):
- CX Gen3 (shared Intel/AMD x86, **EU only**): CX23 2/4GB €5.49 (~$6.49); CX33 4/8GB €8.49 (~$9.99); CX43 8/16GB €15.99 (~$18.49). Note: 2026-09-19 API check showed CX/CAX ~18% above the June table — CX33 ~$9.99, CX43 ~$18.49 USD; **treat as volatile, verify at order time**.
- CAX (ARM64, EU only): CAX21 4/8GB €10.49 (~$12.49) — good value IF all images have arm64 builds.
- CPX Gen2 (AMD shared, EU + SG; **US locations = CPX/CCX only**): US CPX11 2/2GB ~€17.49 ($20.49); CPX21 ~€31.99 ($31.99); CPX31 ~€62.49.
- Availability caveat (Sep 2026): CX/CAX often marked unavailable in several regions.
- Latency note: EU datacenters ~100ms+ RTT from NC. For sidecars accessed from Workers at the edge, the relevant leg is CF edge PoP → sidecar region.

---

## §4 — Cost model (research, 2026-09-27)

### Cloudflare (published 2026 numbers, multiple sources consistent)
| Item | Price |
|---|---|
| Workers Paid | $5/mo incl. 10M req + 30M CPU-ms; overage $0.30/M req, $0.02/M CPU-ms |
| Workers KV | 10M reads / 1M writes incl.; overage $0.50/M reads, $5/M writes+deletes, $0.50/GB-mo |
| R2 | $0.015/GB-mo; Class A $4.50/M; Class B $0.36/M; **$0 egress** |
| Images | ~$5/100K stored + $1/100K transforms (monthly) |
| for-SaaS custom hostnames | 100 free (all plans incl. Free per 2/3 sources); +$0.10/hostname/mo |
| Hyperdrive | UNVERIFIED in this session (historically ~$0.40/M queries; recheck) |

### Neon (2026, post-Dec-2025 change: no monthly minimums)
- Free: 100 CU-hrs + 0.5 GB/project — unsuitable for prod (hard cutoff).
- **Launch: $0.106/CU-hr**, storage $0.35/GB-mo, autoscale to 16 CU, auto-suspend 5 min (disableable), 10 branches. Older "$19/mo Launch / $69/mo Scale" figures are OUTDATED.
- Scale: $0.222/CU-hr, 56 CU, SOC2, 99.95% SLA.
- Workload math: steady always-on 2 CU (2 vCPU/8 GB) = ~1,460 CU-hrs × $0.106 ≈ $155/mo + storage — expensive vs dedicated when always-on; Neon's win is bursty/scale-to-zero. A steady-growth SaaS should disable autosuspend at 1 CU min and budget ~$78–$155/mo for compute alone.
- DB hygiene: use `-pooler` hostname for serverless/Workers; PgBouncer transaction mode only (no SET/LISTEN/temp tables/PREPARE); direct connection for migrations/pg_dump.

---

## §5 — Sidecars: target homes + cost (research, 2026-09-27)

No sidecar runs on Workers natively. Options per sidecar (VPS self-host / managed SaaS / native CF):

| Sidecar | A. One small VPS (self-host) | B. Managed SaaS | C. Native CF replacement | Rec cost |
|---|---|---|---|---|
| Activepieces (MIT) | Docker on VPS, REST from Worker | Cloud from $19/mo | Workers Workflows + Queues could replace simple flows (S; bigger refactor) | VPS share ~$10/mo |
| Listmonk (AGPL-3) | Docker + own DB; Go binary, light | No managed offering (self-host only) | None native (CF Email Routing is inbound-only) | VPS share ~$5/mo |
| Postiz (AGPL-3) | Docker on VPS | Cloud $29/mo Standard (5 channels, 400 posts/mo); no free plan | None native (social APIs need stateful OAuth) | VPS share ~$5–10/mo |
| GrowthBook (open core) | Docker on VPS | Cloud Starter FREE (3 users/1 project, ~1M events/mo); Pro $40/seat/mo | No native CF flags product; could replace with KV + Worker (S/M, loses stats engine) | Free tier / VPS share |
| Umami (MIT) | Docker + PG | Cloud free to 1M events/mo, then $0.00002/event | **CF Web Analytics — free, cookieless, edge-side** | $0 |
| Chatwoot (MIT core) | BYO external (already) | Chatwoot Cloud UNVERIFIED (~$19/agent/mo historically) | None native | status quo |
| Plane (AGPL-3) | BYO external (already) | Plane Cloud UNVERIFIED | None native | status quo |
| Documenso (AGPL CE) | BYO external (already); API-only (embedded signing needs commercial license — red line) | Documenso Cloud UNVERIFIED | None native | status quo |

RECOMMENDED SHAPE: **one residual VPS** (Hetzner CX33 ~$10/mo EU, or DO Basic 2/4GB $24/mo US for lower latency) hosting the 5 sidecars under compose profiles + Cloudflare Tunnel for private edge→VPS egress. GrowthBook → Cloud Starter free tier (kills the container). Umami → CF Web Analytics (kills the container; $0). Chatwoot/Plane/Documenso stay BYO-external (no change).

### Edge → sidecar connectivity
- Workers cannot reach private IPs; **Cloudflare Tunnel (cloudflared)** on the VPS exposes sidecar APIs as HTTPS on your zone — no open ports, no public IPv4 exposure, free. mTLS or service-token auth for Worker→sidecar calls.
- Hyperdrive can also tunnel to private DBs; for sidecar REST, the pattern is fetch() from Worker to tunneled hostname with an API token + short cache where safe.
- Latency: Worker runs at the nearest PoP; CF network → Tunnel egress → VPS region. Put the VPS in US-East (DO/Vultr NYC, or Hetzner US CPX) to match tenant base.

### DigitalOcean (2026): Basic 1/2GB $12, 2/4GB $24, 4/8GB $48, 8/16GB $96 (NYC US regions; Premium AMD variants). Vultr matches at same price points with more NVMe.

---

## §1 (final) — PAYLOAD OPTIONS, EVALUATED

Repo reality (verified): Payload lives at `app/(payload)/{admin,cms-api}`, config at
`payload.config.ts` (schema `payload`, `push: true`, collections CMSUsers/Media/Pages/
Posts). **Nothing in Marketr's app code consumes it** — no `getPayload` calls, no
fetches to `/cms-api` outside Payload's own admin page. It's a standalone editorial
CMS island (landing pages/blog presumably), not woven into the product.

### (a) Keep Payload on a small container/VPS; edge calls /cms-api over HTTPS — RECOMMENDED
- Shape: Payload + Next standalone stays on the residual VPS (or its own tiny CX23,
  ~$6.50/mo EU). Admin on a subdomain (e.g. `cms.<zone>`) routed via Cloudflare
  Tunnel — cleaner than proxying `/admin` through the Worker (Payload admin uses
  HTTP-only session cookies; subdomain avoids cookie-domain rewriting and Host
  mismatches; the Worker approach is possible with header/cookie passthrough but
  is more code).
- Latency: edge → tunnel → VPS adds ~30–150 ms per `/cms-api` call. Since app code
  doesn't fetch it, impact is confined to admin editing and any external consumers.
- Auth: API-key/service-token over TLS for any server-side calls; admin sessions stay
  on the subdomain (never through the Worker).
- Effort: S (compose profile already exists; add tunnel). Risk: LOW.

### (b) Replace 4 collections with native Marketr collections
- What breaks: the React admin UI (rebuild as simple CRUD — S/M), versions/drafts,
  Lexical rich text, CMSUsers auth, REST/GraphQL API compat (matters only if external
  consumers exist — UNVERIFIED, none in-tree).
- Viable ONLY if Tico wants workspace-scoped CMS (multi-tenant pages) — today Payload
  is a single-tenant island, so a native port would be a feature expansion, not a
  migration requirement. Effort: M. Risk: MEDIUM (data port of 4 small collections is
  trivial; the admin UX is the cost).

### (c) Payload on Workers via @opennextjs/cloudflare
- Works officially (one-click template; Paid plan), but: GraphQL on Workers is "not
  currently guaranteed" (upstream workerd#5175 — and Marketr exposes GraphQL at
  `/cms-api/*`); known pg.Pool cross-request-context leak with Neon+Hyperdrive
  (payloadcms/payload#17335) that corrupts unrelated requests after DB autosuspend —
  the exact failure mode of a low-traffic CMS; `push: true` must be replaced with
  real migrations (the config comment already flags this); admin bundle size needs
  Paid plan; `nodejs_compat` + compat flags + IgnorePlugin wiring.
- Effort: M/L. Risk: HIGH for the admin experience, MEDIUM for the API.
- RECOMMENDATION: **defer until the main app is stable on Workers.** The CMS island
  gains nothing from edge latency; it absorbs all of Payload's Workers rough edges.

VERDICT: **(a) now, revisit (c) later, (b) only if multi-tenant CMS becomes a
product requirement.**

---

## §6 — WHITE-LABEL DOMAINS: provisioning flow (Cloudflare for SaaS)

Current state (verified): `white_label_custom_domain` is schema-ready; UI validates
format only; "DNS provisioning is out of scope" — so THIS section is the missing half.

### Provisioning API flow
1. **Fallback origin (one-time):** in the SaaS zone, create an originless proxied
   record (e.g. `AAAA 100::` on a fallback subdomain) and attach a Worker route to
   it. Custom-hostname traffic lands in your zone and matches the Worker route; the
   Worker sees the customer's hostname in the `Host` header.
2. **Per tenant:** `POST /zones/{zone_id}/custom_hostnames` with
   `{hostname: "reviews.acme.com", ssl: {method: "http", type: "dv"}}` →
   returns the hostname object.
3. **Customer DNS:** show the CNAME target in the UI; customer adds one CNAME at
   their DNS provider (or TXT for delegated DCV). Watch `status` (hostname) and
   `ssl.status` (cert) until both are `active`.
4. **Request routing:** Worker reads `Host` → look up `white_label_custom_domain`
   → workspace (KV or D1/Neon read; cache in KV with short TTL) → serve that
   tenant's workspace context. Same Worker serves both the SaaS zone and all
   custom hostnames — no per-tenant deploys.
5. **Removal:** `DELETE /custom_hostnames/{id}`; keep a DB row with a 7-day
   reversible cooldown (recommended pattern from 2026 ADRs) before purge.
6. **Apex limitation:** customer apexes can't CNAME at most registrars; CF Apex
   Proxying is Enterprise-only. Self-serve: support `www.` + redirect, document apex
   as registrar-dependent (ALIAS/ANAME/flattening only).

### Pricing (verify at build time)
- **First 100 custom hostnames free** (per 3 independent 2026 writeups); **$0.10/
  hostname/month** beyond 100; self-serve ceiling 50,000. UNVERIFIED: whether the
  100-free quota applies on the Free plan vs requiring Business ($200/mo) — sources
  conflict; budget as if it might need Business if CF support says so.
- Quota as SKU lever: per-workspace hostname quota (e.g. 1 free / 5 paid) is the
  standard way to bound this cost.

---

## §7 — PHASED CUTOVER (entry/exit + rollback per phase; no hour promises)

Assumptions: tree frozen at the Wave A commit; w2-data.md owns data-plane specifics
(Neon PG16, logical dump/restore, pgvector 0.6.2→0.8.0, `@prisma/adapter-neon` WS
recommended, **Hyperdrive REJECTED for tenant paths** — fail-closed RLS depends on
`SET LOCAL` inside interactive transactions; see w2 §3a). This section sequences
the platform cutover.

### Phase 0 — Foundations & baselines (S)
- Do: provision Cloudflare account + zone, Neon project (PG16, US region), residual
  VPS (sidecar host), Cloudflare Tunnel test; record baselines (req/min, p50/p95
  latencies, DB size, corpus chunk/vector counts, sidecar RAM/disk use).
- Entry: decision log approved (Payload option (a); adapter-neon WS; VPS shape).
- Exit: accounts provisioned, baselines recorded, tunnel reaches VPS.
- Rollback: n/a — nothing live.

### Phase 1 — Data plane to Neon, app still on VM (M)
- Do: logical `pg_dump`/`pg_restore` (public + `payload` schemas; never physical)
  to a Neon branch → rehearse → restore to main; enable extensions; REINDEX the 3
  HNSW indexes; run the hybrid-recall battery vs 0.6.2 baseline (w2 §5); point the
  **VM app** at Neon (Node → Rust engine → direct TCP; no adapter needed on the VM);
  run the RLS battery (zero-row fail-closed proof).
- Exit: app healthy on Neon through a soak; Neon PITR/backups verified; VM PG kept
  as hot standby.
- Rollback: swap `DATABASE_URL` back to the VM PG (one env change + restart).

### Phase 2 — Prisma edge adaptation on the VM (S)
- Do: add `@prisma/adapter-neon` (WebSocket variant — NOT the HTTP variant, which
  lacks callback-form interactive transactions the RLS layer needs) behind an env
  flag; run the full RLS + transaction battery against the `-pooler` endpoint.
- Exit: adapter path green on all tests. Purpose: de-risk Phase 4 without moving traffic.
- Rollback: env flag off — standard client remains.

### Phase 3 — Payload + sidecars to residual VPS (S)
- Do: Payload container on VPS → Neon **direct** string (Node has TCP; no edge
  constraints); compose profiles for Activepieces/Listmonk/Postiz; decision gate:
  GrowthBook → Cloud Starter free tier OR container, Umami → CF Web Analytics;
  admin on `cms.<zone>` via Tunnel; Worker→sidecar HTTPS + API tokens.
- Exit: sidecars + admin healthy on VPS/tunnel through a soak.
- Rollback: current VM compose stays up until soak passes — switch back by DNS/env.

### Phase 4 — Next.js to Workers via @opennextjs/cloudflare (L)
- Do: build with the CF adapter; staging on `*.workers.dev`; full route smoke
  (626 routes), white-label for-SaaS provisioning flow end-to-end (§6), load soak;
  enable the env-flagged adapter path from Phase 2.
- What stays on VM: the entire current stack serving prod until DNS flips.
- Exit: staging parity on errors/latency + budget.
- Rollback: DNS back to the VM origin (minutes).

### Phase 5 — Cutover & retire (S)
- Do: flip DNS to the Worker; monitor 48–72h; decommission VM PG only after Neon
  PITR verified; keep the residual VPS for sidecars + Payload indefinitely.
- Exit: VM terminated (or archived as snapshot). Rollback: re-point DNS within the
  monitoring window.

### Residual VPS steady-state content
Payload container, Activepieces, Listmonk, Postiz, (GrowthBook if not on Cloud),
Cloudflare Tunnel. Nothing else needs a server.

---

## §4 (final) — Cost model totals (USD/mo, honest numbers, 2026-09-27)

| Line | Cost | Note |
|---|---|---|
| Workers Paid | $5 | incl. 10M req + 30M CPU-ms |
| Neon Launch (steady 1–2 CU) | ~$85–165 (UNVERIFIED estimate) | 730–1,460 CU-hrs × $0.106 + ~$3.50–10.50 storage; no monthly minimums since Dec 2025. **Scale-to-zero does not save a live SaaS** — budget always-on. Bursty dev branches scale to zero. |
| R2 (media) | $0–2 | $0.015/GB-mo, $0 egress |
| Images (stock/AI-art pipeline) | $0+ | ~$5/100K stored + $1/100K transforms; scales with usage |
| Hyperdrive | $0 today | no paid tier currently; **not used on tenant path** (w2 §3a); verify — can change |
| Residual VPS | $10–24 | Hetzner CX33 ~$10 EU / CPX11 ~$20 US; DO Basic 2/4GB $24 |
| for-SaaS hostnames | $0 → $0.10/hostname/mo | 100 free first (plan-gating UNVERIFIED) |
| GrowthBook / Umami | $0 | Cloud Starter free / CF Web Analytics free |
| **Steady-state total** | **~$100–195/mo** | before request overages |

vs today: **current VM spend is UNVERIFIED** (not found in this session) — treat any
"cheaper/more expensive" claim as unproven until someone reads the current bill.
The structural story, not the bill: cost shifts from fixed VM rent to metered
compute — Neon compute for an always-on workload is the dominant line, and it
grows linearly with utilization while the VPS rent doesn't.

## §0 — Verdict summary

1. **Payload: keep it on the residual VPS (option a).** It's an isolated CMS island
   — nothing in the app consumes it — so moving it to Workers buys edge latency it
   doesn't need while inheriting Payload-on-Workers rough edges (GraphQL not
   guaranteed, pg.Pool cross-request leak with Neon autosuspend, Paid-only bundle).
   Admin on a tunneled subdomain; `/cms-api` over HTTPS + API keys if ever consumed.
2. **Sidecars: one residual VPS + Cloudflare Tunnel + free-tier swaps.** GrowthBook
   → Cloud Starter (free), Umami → CF Web Analytics (free), Activepieces/Listmonk/
   Postiz stay on the VPS; Chatwoot/Plane/Documenso remain BYO-external. VPS
   $10–24/mo beats $19 (Activepieces Cloud) + $29 (Postiz Cloud) + managed
   everything.
3. **White-label domains: Cloudflare for SaaS.** 100 hostnames free, $0.10/mo each
   beyond; fallback origin + Worker route; `Host:` → workspace lookup; apex
   limitation documented (`www.` + redirect). The in-tree schema/UI is the missing
   half's easy half — the API provisioning loop is what gets built.
4. **Cost: ~$100–195/mo steady state**, dominated by always-on Neon compute
   (~$85–165 of it). Workers/R2/Tunnel are rounding errors at this scale.
5. **Phases: 0 (S) foundations → 1 (M) Neon data plane on VM → 2 (S) adapter
   de-risk on VM → 3 (S) sidecars+Payload to VPS → 4 (L) Next.js to Workers →
   5 (S) DNS cutover + retire VM.** Every phase has an instant or one-env-change
   rollback; prod never moves before its soak passes.

Caveats: prices verified from 2026 public sources but volatile (Hetzner repriced
twice in 2026; Neon's minimum-removal is Dec 2025); GraphQL-on-Workers and the
100-free-hostnames plan-gating are the two UNVERIFIED load-bearing facts.

---
STATUS: COMPLETE (all 5 sections delivered)
