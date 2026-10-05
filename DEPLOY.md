# Deploying ShapesOS

**Hosted production (shapesos.com, app.shapesos.com) is on Render.** Start here:

- [docs/deploy/RENDER.md](docs/deploy/RENDER.md): the Render setup, release, rollback, backups and restore, step by step.
- [docs/deploy/OWNER-CHECKLIST.md](docs/deploy/OWNER-CHECKLIST.md): the ~45 minutes only the owner can do (accounts, payment, domain, keys).
- [docs/deploy/AWS.md](docs/deploy/AWS.md): when and how to move to AWS (the CDK app in `infra/aws`).

The code lives on GitHub (`Villain336/ShapesOS`). CI, the release workflow and the container images are all built from it; releases are a merge to `main` plus the owner's approval of the `production` environment.

The rest of this file is the **self-host runbook**: one machine with Docker Compose (the setup an operator uses to run their own ShapesOS). Its sections (§1a database image and storage, §1b roles and secrets, §3.8 cron) are referenced from the code and tests, and still apply to self-hosting.

---

## 1. Recommended architecture

Single VPS + Docker Compose. The repo already ships `docker-compose.yml` (Postgres 16 with
pgvector, Redis 7, MinIO, a one-shot `migrate` service, the app and scheduled backups), so the
deploy is an ops task, not a code task.

```
Internet → Caddy (auto-HTTPS reverse proxy) → app:3000 (Next.js standalone)
                                              → db:5432 (pgvector/pgvector:pg16, named volume)
                                              → minio:9000 (uploaded files, named volume)
                                              → redis:6379 (named volume)
```

- **VPS:** 2 vCPU / 4 GB RAM minimum (Hetzner, DigitalOcean, or equivalent). Ubuntu 24.04.
- **Domain:** `marketr.launchabl.com` (or similar) → A record to the VPS. Caddy handles TLS.
- **Cron:** the in-app cron runner (Phase 6, `lib/cron/runner.ts`) — on by default in the production server/compose (`CRON_RUNNER=internal`), needs only `CRON_SECRET`. Set `CRON_RUNNER=external` to drive the routes from a host crontab instead (§3.8).
- **Backups:** the compose `backup` service (daily `pg_dump`, retention, optional S3/MinIO upload; see `docs/ops/BACKUP-RESTORE.md`) + the `marketr-minio`, `marketr-data`, `marketr-run-artifacts` and `marketr-corpus` volumes snapshotted.

### 1a. Day-one defaults (Phase 6): database image, file storage, rate limits

A fresh `docker compose up -d` works with no extra steps beyond the §1b secrets. CI checks this on
every push (`compose` job: `docker compose config`, then `db` + `migrate` must exit 0, the
extensions and the app role must exist, and `minio-init` must create the bucket).

- **Database image: `pgvector/pgvector:pg16`.** The memory and substrate migrations run
  `CREATE EXTENSION vector` (and `pg_trgm`, `pgcrypto`); plain `postgres:16-alpine` has no pgvector,
  so a fresh install used to fail at that migration. `pgvector/pgvector:pg16` is the official
  `postgres:16` (Debian) image plus pgvector, with the contrib extensions; CI uses the same image.
  *Upgrading a volume created by `postgres:16-alpine`:* the data directory is compatible (same
  major version), but Alpine (musl) and Debian (glibc) sort text differently, so run
  `docker compose exec db psql -U marketr -d marketr -c 'REINDEX DATABASE marketr'` once after the
  switch (or dump and restore with `docs/ops/BACKUP-RESTORE.md`).
- **Uploaded files go to the bundled MinIO by default** (`MARKETR_STORAGE=s3` in compose). The
  one-shot `minio-init` service creates the bucket (`MARKETR_S3_BUCKET`, default `marketr-files`)
  before the app starts; the bytes live in the `marketr-minio` volume. To use AWS S3, R2 or another
  S3-compatible store instead, set `MARKETR_S3_ENDPOINT`, `MARKETR_S3_REGION`, `MARKETR_S3_BUCKET`,
  `MARKETR_S3_ACCESS_KEY` and `MARKETR_S3_SECRET_KEY` in `.env` (create the bucket yourself).
  `MARKETR_STORAGE=local` keeps files on the `marketr-data` volume instead (one app container only).
  *MinIO image:* MinIO stopped publishing pullable images (`minio/minio` and
  `quay.io/minio/minio` refuse anonymous pulls), so compose uses Chainguard's MinIO build
  (`chainguard/minio:latest-dev`, pinned by digest; override with `MINIO_IMAGE`). It runs as uid
  65532. A `marketr-minio` volume written by an older root-run MinIO needs
  `docker compose run --rm --user 0 --entrypoint chown minio -R 65532:65532 /data` once.
  *Moving existing local files into the bucket:* the storage keys are the same UUIDs in both
  backends, so copy `/app/.data/workspace-files/*` into the bucket as-is (for example with `mc cp`).
- **Everything else on disk has a named volume.** `marketr-data` → `/app/.data` (report and brief
  PDFs, brand logos, site working copies, fix-agent snapshots, sitemaps, the scheduler fallback
  store, local-mode files), `marketr-run-artifacts` → `/app/.run-artifacts` (agent run recordings),
  `marketr-corpus` → `/app/data` (the knowledge corpus). The `*_STORAGE_DIR` variables keep their
  defaults under `/app/.data`; no `.env` changes are needed.
- **Rate limits and the login lockout are shared in Postgres** (`RATE_LIMIT_STORE=postgres`, the
  default whenever `DATABASE_URL` is set): one global `rate_limit_buckets` table, so the limits hold
  when several app containers run. If the database errors or takes over a second, API rate limits
  fall back to the per-process in-memory limiter, and the login lockout falls back to the in-memory
  lockout (it never fails open). `RATE_LIMIT_STORE=memory` restores the per-process behaviour.
  Clear a lockout with
  `docker compose exec db psql -U marketr -d marketr -c "DELETE FROM rate_limit_buckets WHERE key LIKE 'login:%'"`.

### 1b. Database role, required secrets, and bound ports (Phase 1 hardening)

- **The app never connects as the superuser.** Superusers bypass even `FORCE ROW LEVEL SECURITY`,
  which silently disables tenant isolation. The one-shot `migrate` service connects as
  `POSTGRES_USER`, applies migrations, then runs `scripts/db/create-app-role.sql` to create (or
  refresh grants for) `APP_DB_USER` (default `marketr_app`, `NOSUPERUSER NOBYPASSRLS`). The `app`
  service's `DATABASE_URL` uses that role. Verify after boot:
  `docker compose exec db psql -U marketr -c "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = 'marketr_app'"`
  must show `f | f`.
- **No literal secret defaults.** `docker compose` refuses to start until `.env` sets
  `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` and `MINIO_ROOT_PASSWORD` (use `openssl rand -hex 32`; the
  values are embedded in URLs, so stick to hex). The optional sidecars do the same:
  Postiz (`POSTIZ_DB_PASSWORD`, `POSTIZ_JWT_SECRET`), Listmonk (`LISTMONK_DB_PASSWORD`,
  `LISTMONK_ADMIN_PASSWORD`), Umami (`UMAMI_POSTGRES_PASSWORD`, `UMAMI_APP_SECRET`) and
  Activepieces (`AP_POSTGRES_PASSWORD`, `AP_ENCRYPTION_KEY`, `AP_JWT_SECRET`).
- **Ports bind to 127.0.0.1.** The app (`APP_BIND_ADDR`, default `127.0.0.1`), MinIO 9000/9001 and
  every sidecar UI (Postiz, Listmonk, Umami, GrowthBook, Activepieces + its DB/Redis) publish on
  loopback only. Postgres and Redis are not published at all. Put Caddy in front for remote access.
- **Upgrading an existing install** that ran the app as `POSTGRES_USER`: add `APP_DB_PASSWORD` to
  `.env` and `docker compose up -d --build`; the `migrate` service creates the role and grants on
  every table, and the app reconnects as it.
- **Production fails closed on missing secrets.** With `NODE_ENV=production` (the runner image),
  features whose signing/encryption secret is unset refuse to run instead of using a built-in
  fallback, and the fake messaging/mail/call providers are refused unless `ALLOW_FAKE_PROVIDERS=1`.
  See `.env.example` for the list (`MARKETR_APPROVAL_SECRET`, `MESSAGING_UNSUBSCRIBE_SECRET`,
  `PAYLOAD_SECRET`, …).
- **Platform operators.** Host-wide resources — the shared Knowledge corpus (propose/remove/rebuild)
  and Activepieces flow → workspace bindings — can only be changed by users listed in
  `MARKETR_PLATFORM_OPERATORS` (user ids preferred, or emails). Unset = nobody. Bind each
  Activepieces flow to its workspace with `POST /api/integrations/activepieces/bindings
  { flowId, workspaceId }`; unbound flows cannot be triggered or polled from any workspace.
- **Credential key rotation.** Move the old `MARKETR_CREDENTIALS_KEY` into
  `MARKETR_CREDENTIALS_KEY_PREVIOUS` and set a new one; stored credentials keep decrypting.
- **CallRail webhooks are signed per workspace.** `CALLRAIL_WEBHOOK_SECRET` is now a host secret
  from which each workspace's own webhook secret is derived; the `?w=<workspaceId>` in the
  webhook URL only selects which secret must verify, so it can't move events between tenants.
  Print a workspace's URL + secret with
  `CALLRAIL_WEBHOOK_SECRET=… npx tsx scripts/callrail-webhook-secret.mts <workspaceId>`.
  **Migrating an existing install** whose CallRail webhooks sign with the host secret itself:
  set `CALLRAIL_WEBHOOK_ACCEPT_SHARED_SECRET=1` (old signatures keep verifying, each one logs a
  warning), switch every workspace's CallRail webhook to its per-workspace secret, then unset the
  flag. Keep `CALLRAIL_WEBHOOK_SECRET` unchanged during the switch — rotating it rotates every
  workspace's secret.

## 2. Pre-flight — what Tico provides

| # | Item | Notes |
|---|------|-------|
| 1 | VPS provisioned + SSH access | 2 vCPU / 4 GB RAM, Ubuntu 24.04 |
| 2 | Domain + DNS A record | e.g. `marketr.launchabl.com` |
| 3 | DataForSEO login + password | Pay-as-you-go account at dataforseo.com |
| 4 | LLM API key | Anthropic or OpenAI (drives content engine + fix agent) |
| 5 | `AUTH_SECRET` / `NEXTAUTH_SECRET` | `openssl rand -hex 32` |
| 6 | `MARKETR_CREDENTIALS_KEY` | `openssl rand -hex 32` (encrypts stored connector creds) |
| 7 | `CRON_SECRET` | `openssl rand -hex 32` (bearer for scheduled endpoints) |
| 8 | Test targets (see §5) | SFTP host, scratch GitHub repo, WP test site, Webflow token, Vercel/Cloudflare tokens |
| 9 | `RESEND_WEBHOOK_SECRET` | Signing secret from the Resend dashboard webhook (milestone 19 newsletter bounces/complaints) |

Secrets (4–7 and 9) go in `.env` on the VPS only — never in git, never in chat. When ready, Tico hands
them over via the Secure Vault flow and Z7 writes them server-side.

## 3. Runbook

1. **Provision:** fresh Ubuntu 24.04, create deploy user, install Docker + Caddy.
2. **DNS:** A record `marketr.launchabl.com` → VPS IP. Confirm propagation.
3. **Code:** `git clone` the repository (`https://github.com/Villain336/ShapesOS`, private — use a
   deploy key or a token with read access) to `/opt/marketr`.
4. **Env:** copy `.env.example` → `.env`, fill §2 items 3–9. `chmod 600 .env`.
5. **Start:** set the §1b secrets, then `docker compose up -d --build` (§1a covers what the defaults do).
6. **Migrations:** watch the `migrate` service logs — `scripts/db/migrate.sh` (`prisma migrate deploy`) must apply all migrations cleanly
   and the app role must be created (§1b)
   (`..._init` → `..._studio_domains`). The M15 (`..._backlinks_internal_links`), M16
   (`..._local_seo`), M17 (`..._programmatic_seo`), M18 (`..._content_autopilot`), M19
   (`..._newsletter_builder`), M20 (`..._social_scheduling`), and M22
   (`..._studio_domains`)
   migrations are hand-written (no PostgreSQL in the sandbox build environment) — review
   them carefully before deploy.
   Verify with `docker compose exec db psql -U marketr -c "\dt"`.
7. **Caddy:** reverse-proxy `marketr.launchabl.com` → `localhost:3000`, auto-TLS. Confirm HTTPS.
8. **Cron.** Every scheduled sweep is listed, with its cadence, in `lib/cron/jobs.ts`
   (the single source of truth; a unit test fails when a cron route has no entry).
   - **Default — in-app runner (`CRON_RUNNER=internal`):** the app server runs the table
     itself. Only `CRON_SECRET` is needed (`openssl rand -hex 32`); without it the runner
     logs one warning and stays off. Every replica ticks every 15 s, but a Postgres
     advisory lock (`pg_try_advisory_xact_lock`, held for the claim only) lets exactly one
     replica claim each due slot; claims are rows in `cron_runs`, so a restart or failover
     never re-fires a slot and a job never overlaps itself. Each run POSTs to
     `http://127.0.0.1:$PORT/<route>` with the `CRON_SECRET` bearer (override the origin
     with `CRON_RUNNER_ORIGIN` if the server doesn't listen on loopback), with a start
     jitter (≤5 s for every-minute jobs, ≤30 s otherwise) and a per-job timeout (10 or 30
     min). Results (ok / failed / timed out, HTTP status, duration, error excerpt) are kept
     7 days in `cron_runs` and shown to platform operators on Settings → Providers →
     Scheduled jobs. Times are UTC. Off by default under `next dev` (set
     `CRON_RUNNER=internal` to try it), never during `next build` or tests.
   - **External scheduler (`CRON_RUNNER=external`):** keep the host crontab below (or a
     Kubernetes CronJob / PaaS cron — serverless hosts have no long-lived process and must
     use this). Don't run both: the routes are idempotent, but daily sweeps would run twice.
   - Cadences picked in Phase 6 for routes that had none documented (reasons in
     `lib/cron/jobs.ts`): `* * * * *` `/api/cron/workflows` and `/api/scheduler/tick`;
     `*/5` `/api/cron/messaging`, `/api/cron/nurture`; `*/10` `/api/cron/connector-refresh`,
     `/api/calls/reminders/run` (bearer `REMINDERS_CRON_SECRET`, skipped when unset);
     `*/15` `/api/cron/actions`, `/api/cron/contextdev-monitors`; daily `0 2`
     `/api/cron/learning-consolidate`, `15 4` `/api/cron/connector-intro-expiry`, `30 4`
     `/api/cron/connector-paths`, `45 4` `/api/cron/dataset-health`, `0 6`
     `/api/cron/funding-followups`, `15 6` `/api/cron/legal-deadlines`.

   **Host crontab (only with `CRON_RUNNER=external`):**
   - `0 6 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/rankings/check -d '{"scope":"all"}'`
   - `30 6 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/fix-agent`
   - `0 7 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/reports`
   - `30 7 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/platform-radar` (Phase 10 M2: daily platform-change radar — ingests official sources only, classifies rollout/docs/volatility, correlates confirmed rollouts against GSC deltas, writes Growth Memory, emits platform_rollout alerts)
   - `*/15 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/alerts`
   - `0 8 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/visibility-score` (milestone 14: daily composite score + visibility_delta alerts)
   - `5 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/gsc-pull` (Phase 10 M1: hourly GSC Search Analytics pull — last 3h of HOURLY_ALL per GSC-bound project into gsc_snapshot; feeds the delta engine + M2 radar)
   - `20 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/ops-reorder` (Phase 10 ops-core: min/max reorder rules draft purchase orders — drafts only, one per breach)
   - `*/10 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/ops-helpdesk-sla` (Phase 10 ops-core: helpdesk SLA breaches — recorded once per ticket, assignee + editors notified)
   - `*/15 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/gsc-inspection` (Phase 10 M1: URL Inspection queue drain — priority-ordered, fair-share across projects, 2,000 QPD/site hard wall; never sweeps)
   - `0 9 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/decay` (milestone 14: weekly content-decay detection)
   - `30 9 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/radar` (milestone 14: weekly competitor radar)
   - `0 10 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/backlinks` (milestone 15: weekly backlink refresh; per-project backlinksEnabled toggle; cost caps enforced server-side)
   - `30 10 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/internal-links` (milestone 15: weekly internal-link suggestions)
   - `0 11 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/fleet` (Phase 10 M4: weekly competitor-fleet sweep — sitemap/index diffing, robots-aware polite fetch, AI summaries, licensed review adapters only, weekly digest; propose-only)
   - `0 11 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/local-grid` (milestone 16: weekly geo-grid runs; enabled weekly grids due since last run; cost caps enforced server-side)
   - `30 11 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/local-competitors` (milestone 16: weekly local-competitor snapshot refresh; enabled competitors only)
   - `0 12 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/reviews` (milestone 16: weekly review ingest + sentiment summaries + negative-review alerts)
   - `0 7 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/autopilot` (milestone 18: daily sweep; runs only daily/weekly rules whose cadence is due; kill switch, per-run item cap, idempotency, and the approval gate are enforced server-side)
   - `*/5 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/newsletter` (milestone 19: every-5-minutes sweep for due scheduled newsletter broadcasts; send guardrails — verified domain, completed test send, ≥1 subscriber, unsubscribe link — are re-enforced at dispatch; failures audit-log + fire an M13 alert)
   - `*/5 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/social` (milestone 20: every-5-minutes sweep for due scheduled social posts; dispatches to Buffer (their queue publishes), bounded retries on transient failures, per-channel validation + idempotency enforced server-side; permanent failures audit-log + fire an M13 alert)
   - `*/5 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/ads` (milestone 21: every-5-minutes sweep for queued/in-flight Higgsfield ad jobs; submits jobs that never got a provider id, polls due ones on a 30s cadence (40-attempt cap), records actual cost and spend; provider failures audit-log + fire an M13 alert)
   - `0 2 1 * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/storage-metering` (Phase C gaps: monthly storage over-quota ledger charge — per whole GB over quota on the month-end snapshot, rounded up, 1 credit/GB-month; idempotent per workspace per month)
   - `0 3 1 * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/overage-invoicing` (overage invoicing: monthly Stripe invoices for accrued overage on auto-overage workspaces — completed UTC months only, $5.00 minimum (smaller amounts carry forward), replay-safe per workspace per month; no-op when Stripe is unconfigured)
   - `30 2 1 * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/zernio-accounts` (Phase 15.4: monthly Zernio account metering — each workspace's connected Zernio accounts beyond its plan's included accounts at `zernio_account_month`, plus Zernio's managed-ad overage at cost × margin; idempotent per workspace per month; runs before overage invoicing; skipped without `ZERNIO_API_KEY`)
   - `40 5 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/zernio-ads-reports` (Phase 15.4: daily pull of the last 7 days of each workspace's Zernio campaign tree into `ad_reports` — the Advertising reports show Meta/Google/TikTok/LinkedIn/Pinterest/X/OpenAI next to Amazon and StackAdapt; reads only)
   - `* * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/webhooks` (Phase 4a: outbound webhook queue — signed POSTs to workspace endpoints, retries on a 1m/4m/16m… backoff for ~2 days, then dead-letter; bounded to 200 attempts per call)
   - `*/15 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/social-engagement` (Phase 4b: social loop — scheduled posts Postiz reports published → published (+ `social_post.published` webhook) or failed; then daily engagement per post (hourly per post, last 30 days) into `social_post_metrics`, which feeds Attribution and the analytics home)
   - `0 3 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/recording-retention` (Phase 16 slice 8: daily retention sweep — drops videos older than 30 days unless pinned, keeps traces; idempotent per recording)
9. **Smoke test:** log in, create workspace + project, confirm pages load, no console errors.
10. **Backups:** the compose `backup` service runs `scripts/ops/backup.sh --loop` (daily `pg_dump`, 14-day local retention, optional S3/MinIO upload via `BACKUP_S3_*`). Restore procedure and the recorded drill: `docs/ops/BACKUP-RESTORE.md`.
11. **Health:** `GET /api/health` (readiness: DB + migrations, 503 when not ready) and `GET /api/health/live` (liveness, no I/O). The compose `app` healthcheck uses the former; point uptime monitors at it too.

## 4. Live verification checklist (the whole loop, for real)

Run in order; each step must pass before the next.

- [ ] **Keywords (live DataForSEO):** research 5 seed keywords, confirm real volume/CPC/difficulty (not mock).
- [ ] **Competitor gap (live):** add a real competitor domain, run gap analysis, save an opportunity keyword.
- [ ] **Content (live LLM):** generate a brief from a keyword, generate a draft, confirm the SEO score explains itself.
- [ ] **Rank tracking (live):** track 3 keywords, run an on-demand check, confirm real positions in the dashboard.
- [ ] **SFTP (real host):** connect, browse, edit a file in the IDE, AI-propose a diff, apply, confirm audit log entry.
- [ ] **GitHub (real PAT):** connect, browse a scratch repo, commit a change, confirm the commit SHA.
- [ ] **Sites builder:** AI-generate a landing page, preview, save, open in IDE.
- [ ] **WordPress (real app password):** connect, edit a draft post, publish the landing page to WP.
- [ ] **Webflow (real token):** connect, create a CMS item, publish site.
- [ ] **Hosting (real tokens):** deploy the landing page to Vercel, Cloudflare Pages *or* Netlify, visit the live URL; deploy again, then roll back to the first deploy (approve it in Actions) and confirm the URL serves it.
- [ ] **Fix agent (real working copy):** run audit on a test site, approve 2–3 safe fixes, run the scheduled applier, confirm fixes + audit entries, test one-click revert.
- [ ] **RBAC:** invite a second user as `viewer` — confirm read-only; promote to `editor` — confirm no member management; demote/remove.
- [ ] **Audit log review:** confirm credential changes, deploys, fix-agent runs, and role changes all appear.
- [ ] **Newsletter (live Resend, BYO key):** add a workspace Resend key, add a sending domain, copy the SPF/DKIM/DMARC records into DNS, verify the domain, import a 3-address CSV list, build a template from a starter, send a test email, then send a real broadcast to the test list; confirm the unsubscribe link works, the webhook flips a bounced address, and the audit log + alert fire on a forced failure.
- [ ] **Cron:** with the in-app runner on, confirm the startup log line `in-app cron runner started` and, after a few minutes, `ok` rows on Settings → Providers → Scheduled jobs (platform operator). With `CRON_RUNNER=external`, trigger the cron endpoints manually with `CRON_SECRET` and confirm 200s and expected side effects.
- [ ] **Studio (Porkbun domains, sandbox only):** with sandbox/dry-run keys, save
  keys, search availability, view TLD pricing, save a registrant, preview a
  purchase, confirm it with the terms checkbox — confirm the domain row lands
  `registered` with nameservers + audit entries. Never run a production purchase
  during verification.

## 4b. Ad factory environment requirements (milestone 21)

- Each workspace brings its own Higgsfield API key (Ad factory → Settings) — stored encrypted with
  `MARKETR_CREDENTIALS_KEY`; the key is never returned by the API. Auth header format:
  `Authorization: Key KEY_ID:KEY_SECRET` against `https://platform.higgsfield.ai`.
- **Before production image generation:** confirm the image model slug via `GET /models` against a real
  key. The video default (`bytedance/seedance-2.5/image-to-video`) is verified; the image default
  (`bytedance/seedance-2.5/text-to-image`) is a configurable placeholder and MUST be replaced with a
  live catalog slug if it 404s. Video without a reference image likewise needs a text-to-video slug
  from the live catalog.
- Cost estimates shown in the UI are illustrative constants — reverify current provider pricing before
  billing. The workspace monthly spend cap (default $50) is enforced server-side.
- Scheduled polling needs the host cron entry `*/5 * * * * … /api/cron/ads` (see §3.8).
- Live check: add a key, create a campaign with a brand kit, generate 1 image variant, confirm it
  reaches `ready`, approve it, send it to social, confirm the post draft appears in the social studio
  and the spend summary increments.

## 4c. Studio environment requirements (milestone 22: Porkbun domains)

- **Single-instance limitation:** domain-purchase confirmation tokens live in
  process memory (5-minute TTL). The purchase confirm MUST hit the same app
  instance — run a single app container (or sticky sessions) until these move
  to Redis/shared storage.
- **Porkbun:** API keys are entered per-workspace in the Studio → Domains tab
  (encrypted with `MARKETR_CREDENTIALS_KEY`; only the key tail is shown back).
  Porkbun registration uses the account's default registrant contact — the
  `domain/create` API accepts no contact fields — so set the account contact in
  the Porkbun dashboard. Registration creates ICANN email-verification
  obligations; the purchase wizard shows the disclosure and requires an explicit
  terms checkbox.
- **Zero-spend rule for first verification:** the first end-to-end domain test
  must use Porkbun sandbox keys / a dry run — NEVER a production purchase. The
  wizard blocks premium domains (registry-premium names can't be registered via
  the API), re-checks availability and price immediately before charging, and
  aborts on any change.
- Owner/admin only for Porkbun keys.
- Live check: (sandbox) search a domain, save a registrant, preview a purchase,
  confirm it, and confirm the domain row lands `registered` with nameservers +
  audit entries.

## 4a. Newsletter environment requirements (milestone 19)

- Each workspace brings its own Resend API key (Settings → Newsletter → Domains & settings) — stored
  encrypted with `MARKETR_CREDENTIALS_KEY`; the key is never returned by the API.
- `RESEND_WEBHOOK_SECRET` (in `.env`): the signing secret from the Resend dashboard webhook
  configured to POST to `https://marketr.launchabl.com/api/newsletter/webhooks/resend`. Without it,
  webhook events are accepted unsigned and a warning is logged — set it before production.
- Sending domains need SPF + DKIM (issued by Resend at domain creation) plus a DMARC TXT record —
  the setup wizard shows the exact records and a "Verify now" button.
- Scheduled broadcasts need the host cron entry `*/5 * * * * … /api/cron/newsletter` (see §3.8).

## 4d. Agent worker and code sandbox (Phase 8)

- **Worker.** `docker compose up` starts a `worker` service (`scripts/worker.mts`)
  that claims `agent_jobs` (`SKIP LOCKED`, leases + heartbeats, a dead run is
  requeued and resumes from its saved transcript). The app runs with
  `AGENT_WORKER=external`: a chat turn still running after
  `AGENT_INLINE_BUDGET_SECONDS` (45) is handed to the worker; build-mode turns
  go straight there. Without compose, `AGENT_WORKER=internal` runs the worker
  loop inside the app process; `off` keeps every turn inline. Budgets:
  `AGENT_MAX_STEPS` (40), `AGENT_MAX_RUN_MINUTES` (30),
  `AGENT_MAX_RUN_COST_MICRO_USD` ($10). All in `.env.example`.
- **Code sandbox.** Off by default (no provider → the code tools say why, never
  fake). Pick one:
  - Hosted microVMs (recommended for shared/production hosts):
    `SANDBOX_PROVIDER=e2b` + `E2B_API_KEY`, or `SANDBOX_PROVIDER=daytona` +
    `DAYTONA_API_KEY`. Nothing else to mount.
  - Docker on a dedicated host:
    `docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d`
    (mounts the Docker socket — root-equivalent — into app and worker; see the
    file's header). Set `DOCKER_GID` to the socket's group id.
- **GitHub.** Agents push only to `shapes/<run-id>` branches and open PRs after
  an approval. Uses a GitHub site's personal access token, or a GitHub App when
  `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` are set.
- **Live checks (unverified in CI — no Docker daemon or keys there):** Docker
  container create / archive PUT / previews; the E2B and Daytona adapters; real
  GitHub branch → push → PR; the Claude loop with native tools, caching and
  compaction.

## 4e. Sites: agent drafts, Netlify, rollback and live smoke tests (Phase 9)

- **Agents edit sites in the sandbox.** `site_checkout` copies a site's working
  copy (Sites → IDE files) into the run's code sandbox (needs a sandbox
  provider, §4d); `site_publish_draft` saves the result as a draft revision.
  Nothing goes live until a person clicks **Apply** under Sites → Agent drafts
  (the previous files are kept as a backup revision — **Restore** reverts).
  Deploy / publish afterwards as usual.
- **Netlify** joins Vercel and Cloudflare Pages under Sites → Hosting (personal
  access token, optional site id; file-digest deploys). Tokens are per
  connection, encrypted at rest — no env var.
- **One-click rollback.** Deployment history → **Roll back** requests a Tier-2
  approval (Actions / the "needs you" inbox); once approved, **Run rollback**
  calls the provider (Vercel instant rollback, Cloudflare Pages rollback,
  Netlify restore deploy) and records a rollback row.
- **Live smoke tests (opt-in).** `npx tsx scripts/live/run-all.mts` runs
  `scripts/live/{github,wordpress,webflow,vercel,cloudflare,netlify,anthropic}.mts`
  through the app's own adapters. Each SKIPS unless its `LIVE_*` keys are set
  (listed in `.env.example`); deploy + rollback checks also need
  `LIVE_DEPLOY_WRITE=1` and create deployments in scratch projects. In GitHub:
  add the `LIVE_*` repository secrets, then run **Actions → live-smoke → Run
  workflow** (`.github/workflows/live-smoke.yml`, `workflow_dispatch` only —
  never on push or PR). `LIVE_ONLY=netlify,anthropic` limits a run.

## 5. Test targets (safe, non-production)

- SFTP: a disposable directory on a Launchabl staging host (NOT a client site).
- GitHub: a new scratch repo (e.g. `launchabl/marketr-smoke`), deleted after.
- WordPress: a staging WP install with an application password.
- Webflow: a test workspace + API token.
- Vercel/Cloudflare/Netlify: tokens scoped to test projects; tear down deployments after.

## 6. Rollback

- Every milestone is a git commit; tag what you deploy (`git tag deploy-2026-09-21 && git push --tags`).
  Rollback = `git checkout <previous-tag> && docker compose up -d --build`. (Hosted: roll back in the
  release workflow or the Render dashboard — docs/deploy/RENDER.md §11.)
- Database: restore from the nightly `pg_dump`. Migrations are forward-only; a code rollback with a
  newer DB schema is safe as long as no migration is reverted (none planned).

## 7. Out of scope for this deploy

Public launch, Product Hunt, public GitHub repo, billing/Stripe wiring, SSO against a real IdP,
KMS provider implementation, SOC 2 evidence gathering. Those follow after the internal beta proves
the loop.

---

## Decisions

The hosting decision is made (owner, 2026-10-05): Render now, AWS-ready, move when a trigger in
docs/deploy/AWS.md hits. For a self-hosted machine the choices are yours: provider, domain, and
which keys to set (docs/KEYS.md lists every key and where it comes from).
