# W2 Data Layer — Cloudflare migration research (scratch, 2026-09-27)
READ-ONLY worker. No code changes, no builds, no migrations, no servers started.

## 1. Repo verification (seed facts checked, not trusted blindly)

| Seed claim | Verified |
|---|---|
| Prisma `@prisma/client` ^6.19.3 | **6.19.3 exact** |
| 248 models | **247** `model` blocks in prisma/schema.prisma (close) |
| 66 migrations | **67** migration dirs in prisma/migrations (close) |
| Postgres 16 port 5433 | port 5433 live; `psql` works |
| pgvector 0.6.2, vector(384) on Growth Memory | **Confirmed**: vector=0.6.2, pg_trgm=1.6, pgcrypto=1.3; HNSW (cosine_ops, m=16, ef_construction=64) on memory_episodes, memory_facts, memory_learnings |
| pg_trgm 1.6 | confirmed 1.6 |
| Hybrid retrieval tsvector/trgm + pgvector HNSW → fusion → cross-encoder → MMR | confirmed in lib/substrate/memory/recall.ts (ts_rank + `<=>` ORDER BY) |
| lib/prisma.ts pooling | **NO pooling. No PgBouncer, no pg-pool.** Single `new PrismaClient()` module-scope singleton, no adapter, no `datasourceUrl` override. Standard Rust engine, direct TCP to DATABASE_URL. |
| Migrations can `CREATE EXTENSION vector/pg_trgm/pgcrypto` | Migrations use `CREATE EXTENSION IF NOT EXISTS` (some guarded behind superuser notices) |
| schema.prisma datasource | `url = env("DATABASE_URL")` only; prisma.config.ts supplies a dummy fallback URL when DATABASE_URL unset |

Key repo facts affecting the migration:
- 122 `queryRaw`/`executeRaw` call sites across lib/ — all raw SQL audited for PG features (see §3).
- RLS is load-bearing and fail-closed: FORCE ROW LEVEL SECURITY on all Growth Memory substrate tables; policy `workspace_id = current_setting('app.workspace_id', true)`; sessions without the GUC see ZERO rows (incl. table owner). All access via `withWorkspaceScope()` = `prisma.$transaction` + `SET LOCAL app.workspace_id = '...'` (escapeLiteral'd).
- Secondary GUC `app.playbook_reviewer` used for the review-queue gate.
- A dedicated worker client exists: `workerPrisma` in lib/substrate/memory/consolidate.ts (new PrismaClient with `datasourceUrl` = DATABASE_URL + `?connection_limit=N`, optional `MEMORY_WORKER_ROLE=marketr_memory_worker` role).
- Unsupported() columns: `vector(384)` and `tsvector` — Prisma schema marks them opaque; all vector/tsquery work is raw SQL.

## 2. Neon support — pgvector, pg_trgm, HNSW, branching (web research, Sept 2026)
_(pending)_

## 2. Neon support — pgvector, pg_trgm, HNSW, branching (verified 2026-09-27)

Sources: official Neon docs (neon.com/docs/extensions/pg-extensions table + /docs/extensions/pgvector, crawled today), pgvector CHANGELOG.

| Feature | Local today | Neon today (PG16 project) | Verdict |
|---|---|---|---|
| pgvector | 0.6.2 | **0.8.0** on PG14/15/16/17; 0.8.6 on PG18. One-version-back install allowed (0.7.4) via `CREATE EXTENSION vector VERSION '0.7.4'` | ✅ supported; version skew handled in §5 |
| pg_trgm | 1.6 | **1.6** on PG16 (exact match) | ✅ zero skew |
| pgcrypto | 1.3 | **1.3** on PG16 (exact match) | ✅ zero skew |
| HNSW index | `USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)` | Fully supported; docs give the exact same cosine pattern; `vector` up to 2000 dims; `m` default 16, `ef_construction` default 64 | ✅ DDL transfers verbatim |
| Distance ops `<->` `<=>` `<#>` `1-(<=>)` | used in recall.ts | All documented | ✅ |
| tsvector/tsquery/ts_rank, GIN trigram | used in recall.ts | Full Postgres, no limits | ✅ |
| `SET LOCAL` in transactions | RLS + `SET LOCAL hnsw.ef_search` patterns | Documented as the standard pattern in Neon's own pgvector docs | ✅ |
| CREATE EXTENSION as non-superuser | migrations use `IF NOT EXISTS` with superuser notices | On Neon, `CREATE EXTENSION vector/pg_trgm/pgcrypto` works for the project owner role (no superuser needed; Neon's managed role model). The existing `IF NOT EXISTS` migrations are idempotent and safe to replay. | ✅ |
| Postgres version | 16 | PG16 is a first-class project version (all three extensions have PG16 columns; PG18 exists but 18's pgvector 0.8.6 vs 0.8.0 is an unnecessary extra skew) | Pin Neon project to **PG16** |

**Branching → preview DBs mapping.** Neon branches are instant copy-on-write forks of a parent (no data copied; storage billed only for divergence). Each branch gets its own compute endpoint (auto scale-to-zero independently) and its own pooled (`-pooler`) + direct connection strings. Mapping:
- `main` branch = production Neon project database.
- Preview/staging environments = branches (per-PR or per-environment, created via `neonctl branches create` or the Neon API; deleted on merge/close).
- Each branch carries its own extensions state, so `CREATE EXTENSION vector` must run per branch (a migration applied per branch covers this).
- Branch compute scales to zero after ~5 min idle; first query after suspend pays a resume (hundreds of ms, can surface as a transient connection failure — the app/client should retry once).
- Migrations run per branch with the branch's **direct (non-pooled)** string (see §3).

## 3. Prisma on Workers — options, changes, recommendation

### 3a. Options evaluated

**Option A — Hyperdrive (pooling to origin DB).** ❌ REJECTED for the request path.
- Cloudflare's own docs list as **unsupported through Hyperdrive: `SET` statements**, named prepared statements, advisory locks, LISTEN/NOTIFY. Marketr's tenant isolation is literally `SET LOCAL app.workspace_id` — a SET statement. Community notes suggest SET may pass through inside explicit transactions, but for a fail-closed, load-bearing security mechanism "maybe works" is disqualifying.
- Hyperdrive's **query cache is ON by default** (60s max_age, writes don't invalidate matching reads). Cache keys are query text — not the tenant GUC. RLS-scoped reads through a shared cache are a cross-tenant data-leak hazard. (There is a per-config cache-disable, but the default is dangerous and the isolation model shouldn't depend on a dashboard toggle.)
- Also: Hyperdrive does not provision Postgres; it still needs an origin DB (Neon). It adds a hop without removing one.
- Verdict: do not use Hyperdrive on any tenant-scoped read/write path. (It remains a possible accelerator for non-tenant analytics reads only — not recommended; keep the stack to one path.)

**Option B — Prisma driver adapter `@prisma/adapter-neon` (WebSocket) → Neon.** ✅ RECOMMENDED.
- This is Prisma's officially documented Workers path ("If you are using a Neon database, use `@prisma/adapter-neon`").
- Driver adapters are **GA in Prisma 6.7+** — on 6.19.3 no preview flag is needed.
- Interactive `$transaction(async tx => …)` **works** with the WebSocket variant (`PrismaNeon` / `new Pool` from `@neondatabase/serverless`): real sessions to the Neon compute, BEGIN on a dedicated client. (The *HTTP* variant `PrismaNeonHttp` supports only the array form — unusable here since the entire RLS layer is callback-form interactive transactions. Do not use the HTTP variant.)
- Rust query engine binary is not needed — the adapter is pure JS/TS, Workers-compatible.
- No extra vendor hop, no extra cost tier; Neon's own PgBouncer (`-pooler` endpoint) handles connection multiplexing.

**Option C — Prisma Accelerate.** ❌ NOT RECOMMENDED (viable but inferior).
- Interactive transactions are supported (Accelerate FAQ lists configurable interactive-tx timeouts), so it would technically work, and RLS SET LOCAL inside a tx passes through like any PG statement.
- But: it adds a second vendor, a second bill, another failure domain, and query-caching semantics to reason about — for a database that already ships its own pooler. No compensating advantage for this stack.

**Option D — `@prisma/adapter-pg` (node-postgres) direct TCP.** ❌ REJECTED.
- Requires TCP from the Worker (node:net compat) and re-introduces the connection-exhaustion problem serverless pooling was solving; Prisma-over-PgBouncer needs `?pgbouncer=true` handling and prepared-statement care. Strictly worse than the Neon-native adapter.

### 3b. Recommendation: Option B — `@prisma/adapter-neon` (WebSocket) against Neon's pooler endpoint

Reasons: (1) official Prisma↔Workers path; (2) only option besides direct TCP that preserves interactive transactions, which the RLS layer requires; (3) Hyperdrive's documented `SET`-statement exclusion directly threatens the tenant-isolation mechanism; (4) Neon already provides pooling + branching, so no second service needed.

### 3c. Migration workflow (migrations can't run from the edge)
- Migrations run from **CI (GitHub Actions / equivalent) with `DIRECT_URL`** = Neon **direct (non-pooled)** endpoint, `prisma migrate deploy`. Never from a Worker, never at request time, never against the `-pooler` URL (DDL + PgBouncer transaction mode = advisory-lock/prepared-statement failures).
- Each Neon branch (preview/staging) is migrated independently with that branch's direct string.
- Prisma 7 note (Jan 2026, Prisma 7.0–7.5 era): in v7, datasource URLs move out of schema.prisma into `prisma.config.ts` and driver adapters become mandatory. **The current tree is Prisma 6.19.3.** Do NOT bundle a Prisma 7 upgrade into the Cloudflare migration — do the adapter cutover on 6.19.3 first, upgrade Prisma separately later. (On v7 the same architecture holds: `prisma.config.ts` `datasource.url` = `DIRECT_URL`, runtime adapter carries `DATABASE_URL`.)

## 4. What breaks — raw SQL audit + RLS-through-pooling verdict

### 4a. Raw SQL / PG-feature audit (122 call sites, read-only review)
- **Safe on Neon:** `<->` / `<=>` cosine/L2 ops, `ts_rank`, `to_tsquery`/`plainto_tsquery`/`websearch_to_tsquery`, trigram `%`/`similarity()`, tsvector GIN, `gen_random_uuid` (pgcrypto 1.3 present), PL/pgSQL DO blocks in migrations, partial indexes, expression indexes, `CREATE INDEX … USING hnsw`, `WHERE embedding IS NOT NULL` partial HNSW.
- **Absent (verified by grep):** LISTEN/NOTIFY, advisory locks, `pg_cron`, dblink, session-level `SET`/`SET SESSION` in app code, `gen_random_uuid` in lib (migrations may use it — covered by pgcrypto).
- **No cross-schema or search_path tricks; no `pg_database_size` introspection in hot paths.**

### 4b. RLS-through-pooling VERDICT: ✅ SAFE with the recommended path
Mechanics of the current design:
- `withWorkspaceScope()` = `prisma.$transaction(async tx => { SET LOCAL app.workspace_id = '…'; …fn(tx) })`.
- `SET LOCAL` is **transaction-scoped**, not session-scoped. Through PgBouncer **transaction** pooling mode, a connection is pinned to the client for the whole transaction, so `SET LOCAL` applies exactly to that transaction and is discarded at COMMIT/ROLLBACK — no leakage to the next borrower. This is the textbook-correct pattern for RLS-over-poolers.
- With `@prisma/adapter-neon` (WebSocket): interactive tx runs on a dedicated session/client; the tx's statements (including `SET LOCAL`) go to the same backend. The neon WS Pool does not multiplex statements across backends mid-transaction.
- The fail-closed property is preserved: FORCE RLS means any path that somehow drops the GUC sees zero rows, including table owners. The failure mode of a pooling bug is *no data*, not *wrong tenant's data* — the architecture degrades closed, which is the property that matters.
- **One endpoint decision remains (test-gated):** point the WS adapter at the **pooled (`-pooler`) endpoint** (recommended for Worker concurrency) — and run the RLS battery (`countWithoutScope` zero-row proof + cross-workspace negative tests) against it before cutover. If the pooled endpoint ever shows tx-pinning anomalies, the direct endpoint is the fallback (fewer, longer-lived connections; fine for the current scale).
- **Do NOT add `?pgbouncer=true`** to Neon URLs — that flag is for third-party PgBouncer setups; Neon uses the `-pooler` hostname convention instead.

## 5. pgvector version skew: 0.6.2 → 0.8.0
- **Operator/index compatibility:** no break. `<=>` + `vector_cosine_ops` HNSW is unchanged across 0.6→0.8; `vector(384)` on-disk format (float4 array) is stable; `m`/`ef_construction` defaults (16/64) match what the migrations pin explicitly.
- **The 0.6.0 storage change** (vector TOAST storage `extended`→`external`) is a type-level default, not an index format break; a logical dump/restore picks up the new default automatically. Indexes are rebuilt from `CREATE INDEX` DDL on restore, so there is no binary index-format migration to worry about — **use logical `pg_dump`/`pg_restore` (or Neon import), never a physical copy.**
- **Minor behavioral deltas to verify, not fear:** HNSW build got parallel builds (0.6+) and recall/latency tuning changed slightly across releases; `ef_search` default is still 40. Any drift would show as recall-ordering noise, not errors.
- **Migration acceptance test:** after restoring to a Neon branch on 0.8.0, run the hybrid-recall battery against the same corpus and diff top-k results vs the 0.6.2 baseline; then `REINDEX` the three HNSW indexes once on the final data (cheap insurance, also defragments).
- Net risk: **LOW**. No schema changes needed; no re-embedding needed (MiniLM 384-dim vectors are untouched by the extension upgrade).

## 6. Recommended data architecture (target state)

```
Cloudflare Worker (request path)
  └─ lib/prisma.ts → new PrismaClient({ adapter: PrismaNeon({ connectionString: DATABASE_URL }) })
       DATABASE_URL = Neon pooled endpoint  (-pooler…neon.tech, ?sslmode=require)
       @prisma/adapter-neon + @neondatabase/serverless (WebSocket variant — interactive tx OK)
       RLS unchanged: withWorkspaceScope() = $transaction + SET LOCAL app.workspace_id
            (transaction-pinned through PgBouncer; fail-closed preserved)

Background workers (consolidation, missions engine, schedulers)
  └─ same adapter pattern; workerPrisma keeps its separate-client discipline,
     pool sizing moves from `?connection_limit=` URL param → neon Pool options
     (MEMORY_WORKER_ROLE role mapping preserved via Neon roles)

Migrations / DDL
  └─ CI job only: prisma migrate deploy with DIRECT_URL = Neon direct (non-pooled)
     endpoint; one run per branch (main + each preview branch)

Environments
  └─ Neon project (pinned PG16) → main branch = prod
     └─ branches (copy-on-write, instant) = staging / per-PR preview DBs,
        each migrated independently, deleted on merge
```

## 7. File-level change list (for the implementing worker — W2 made NO changes)

| # | File | Change |
|---|---|---|
| 1 | `package.json` | add `@prisma/adapter-neon`, `@neondatabase/serverless` (runtime deps). No Prisma version change (stay 6.19.3). |
| 2 | `lib/prisma.ts` | Replace bare `new PrismaClient()` with `new PrismaClient({ adapter })` where `adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL })`. Decide per-request vs module-scope client construction and verify against Workers' "Cannot perform I/O on behalf of a different request" rule (see UNVERIFIED #1). |
| 3 | `prisma/schema.prisma` | datasource: add `directUrl = env("DIRECT_URL")` (migrations/CLI). Keep `url = env("DATABASE_URL")`. Do NOT remove the `url` key (Prisma 6.19 CLI requires it). |
| 4 | `prisma.config.ts` | Point CLI datasource at `DIRECT_URL` semantics: ensure `migrate deploy`/`db push`/`studio` resolve the direct (non-pooled) Neon endpoint. Keep the dummy-fallback pattern for offline `validate`/`generate`. |
| 5 | `lib/substrate/memory/consolidate.ts` (`workerPrisma`) | Move pool sizing from `?connection_limit=N` URL param to neon Pool options; keep `MEMORY_WORKER_ROLE` role selection (map to a Neon role). Same adapter construction as lib/prisma.ts. |
| 6 | `.env` / secrets / CI env | Split into `DATABASE_URL` (pooled, runtime) + `DIRECT_URL` (direct, migrations). Both per Neon branch. Never commit; Cloudflare secrets for the Worker, CI secrets for the migrator job. |
| 7 | New: migration CI job | `prisma migrate deploy` against `DIRECT_URL`, run per branch; gate preview deploys on branch-migration success. |
| 8 | `lib/substrate/*/rls.ts` (graph, campaigns, memory) | **No logic change expected** — but the RLS battery (incl. `countWithoutScope` zero-row proof and cross-workspace negative tests) must be re-run against the pooled endpoint before cutover. |
| 9 | `lib/substrate/memory/recall.ts` | No change (raw SQL is Neon-safe per §4a). Post-restore: recall-parity diff vs 0.6.2 baseline + one `REINDEX` of the three HNSW indexes. |
| 10 | Old migrations (67) | No edits (rule: never edit applied migrations). Replay as-is on Neon; `CREATE EXTENSION IF NOT EXISTS` lines are idempotent there. |

Explicitly NOT changing: raw SQL queries, RLS policies/GUC names, pgvector dims/index params, Prisma version (no v7 upgrade in this migration).

## 8. UNVERIFIED list (must be closed by testing before cutover)
1. **Per-request vs module-scope PrismaClient on Workers with adapter-neon.** Community evidence says a module-level neon WS Pool reused across requests can throw "Cannot perform I/O on behalf of a different request"; one project constructs the client fresh per call. The official Prisma Cloudflare example constructs the adapter inside the request handler. The implementing worker must load-test both and pick the pattern that survives sustained multi-request traffic on one isolate.
2. **`-pooler` vs direct endpoint for the WS adapter under interactive transactions + SET LOCAL.** Expected safe (tx pinning), but the RLS fail-closed battery must pass on the exact endpoint string that ships.
3. **Neon scale-to-zero resume behavior under the WS adapter.** First-query-after-suspend can surface as a transient connection failure; verify the client/adapter retries once (or add a single retry at the call boundary) so cold branches don't 500.
4. **Recall parity 0.6.2 → 0.8.0.** Run the hybrid retrieval battery on a restored branch and diff top-k vs the local baseline before promoting the branch. (Expected: no meaningful drift.)
5. **`prisma migrate deploy` from CI against Neon direct endpoint with the existing 67-migration history.** Replay all migrations on a scratch branch first; watch the superuser-notice fallbacks and the HNSW builds under Neon's `maintenance_work_mem` defaults.
6. **Prisma 7 boundary.** This plan assumes staying on 6.19.3. If the coordinator upgrades to Prisma 7.x, re-verify: adapter API shape (`PrismaNeon` options), mandatory `generator output`, and `prisma.config.ts` datasource semantics per §3c — the architecture survives, the file list shifts slightly.
7. **Neon project quotas for branches.** Branches share the project's pooled-connection ceiling and storage quota; size the plan tier against (branches × compute) before promising per-PR preview DBs.

---
W2 complete. No code modified, no builds run, no migrations run, no servers started. Scratch file: ~/workspace/marketr/docs/migration/scratch/w2-data.md
