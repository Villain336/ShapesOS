# Marketr — First Real Deployment (Launchabl internal beta)

**Goal:** get Marketr running on real infrastructure with a real database, live API keys, and real
third-party connections, then exercise the full loop end-to-end:
research → content → publishing → ranking → site-fix.

**Status:** SPEC — not yet executed. Nothing here runs until Tico approves.

---

## 1. Recommended architecture

Single VPS + Docker Compose. The repo already ships `docker-compose.yml` (Postgres 16, Redis 7, app
with `prisma migrate deploy` on boot), so the deploy is an ops task, not a code task.

```
Internet → Caddy (auto-HTTPS reverse proxy) → app:3000 (Next.js standalone)
                                              → db:5432 (Postgres, named volume)
                                              → redis:6379 (named volume)
```

- **VPS:** 2 vCPU / 4 GB RAM minimum (Hetzner, DigitalOcean, or equivalent). Ubuntu 24.04.
- **Domain:** `marketr.launchabl.com` (or similar) → A record to the VPS. Caddy handles TLS.
- **Cron:** host-level cron `curl` hitting the two scheduled endpoints with `CRON_SECRET` bearer.
- **Backups:** the compose `backup` service (daily `pg_dump`, retention, optional S3/MinIO upload; see `docs/ops/BACKUP-RESTORE.md`) + the `marketr-data` volume snapshotted.

### 1a. Gap to fix before deploy (small code change, spec'd here)

`docker-compose.yml` currently has **no volume for `.data/`** — site working copies (M7),
fix-agent snapshots (M10), report PDFs + brand-kit logos (M12), and programmatic-SEO
sitemaps (M17, `.data/sitemaps`, unless `SITEMAP_STORAGE_DIR` points elsewhere) live on the
container's writable layer. They survive restarts but are lost on `compose down` / rebuild. Before deploy:

1. Add a named volume: `marketr-data:/app/.data` on the `app` service.
2. Set `SITE_STORAGE_DIR=/app/.data/sites`, `FIX_SNAPSHOT_DIR=/app/.data/fix-snapshots`,
   `REPORT_STORAGE_DIR=/app/.data/reports`, and `SITEMAP_STORAGE_DIR=/app/.data/sitemaps` in `.env`.
3. Rebuild and confirm a site working copy survives `docker compose down && docker compose up -d`.

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
3. **Code:** `git clone` the vault repo to `/opt/marketr` (local-only remote — this stays private;
   no GitHub remote is created).
4. **Env:** copy `.env.example` → `.env`, fill §2 items 3–9. `chmod 600 .env`.
5. **Data volume fix:** apply §1a, set the §1b secrets, then `docker compose up -d --build`.
6. **Migrations:** watch the `migrate` service logs — `npx prisma migrate deploy` must apply all migrations cleanly
   and the app role must be created (§1b)
   (`..._init` → `..._studio_domains`). The M15 (`..._backlinks_internal_links`), M16
   (`..._local_seo`), M17 (`..._programmatic_seo`), M18 (`..._content_autopilot`), M19
   (`..._newsletter_builder`), M20 (`..._social_scheduling`), and M22
   (`..._studio_domains`)
   migrations are hand-written (no PostgreSQL in the sandbox build environment) — review
   them carefully before deploy.
   Verify with `docker compose exec db psql -U marketr -c "\dt"`.
7. **Caddy:** reverse-proxy `marketr.launchabl.com` → `localhost:3000`, auto-TLS. Confirm HTTPS.
8. **Cron (host crontab):**
   - `0 6 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/rankings/check -d '{"scope":"all"}'`
   - `30 6 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/fix-agent`
   - `0 7 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/reports`
   - `30 7 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/platform-radar` (Phase 10 M2: daily platform-change radar — ingests official sources only, classifies rollout/docs/volatility, correlates confirmed rollouts against GSC deltas, writes Growth Memory, emits platform_rollout alerts)
   - `*/15 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/alerts`
   - `0 8 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/visibility-score` (milestone 14: daily composite score + visibility_delta alerts)
   - `5 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/gsc-pull` (Phase 10 M1: hourly GSC Search Analytics pull — last 3h of HOURLY_ALL per GSC-bound project into gsc_snapshot; feeds the delta engine + M2 radar)
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
- [ ] **Hosting (real tokens):** deploy the landing page to Vercel *or* Cloudflare Pages, visit the live URL.
- [ ] **Fix agent (real working copy):** run audit on a test site, approve 2–3 safe fixes, run the scheduled applier, confirm fixes + audit entries, test one-click revert.
- [ ] **RBAC:** invite a second user as `viewer` — confirm read-only; promote to `editor` — confirm no member management; demote/remove.
- [ ] **Audit log review:** confirm credential changes, deploys, fix-agent runs, and role changes all appear.
- [ ] **Newsletter (live Resend, BYO key):** add a workspace Resend key, add a sending domain, copy the SPF/DKIM/DMARC records into DNS, verify the domain, import a 3-address CSV list, build a template from a starter, send a test email, then send a real broadcast to the test list; confirm the unsubscribe link works, the webhook flips a bounced address, and the audit log + alert fire on a forced failure.
- [ ] **Cron:** trigger both cron endpoints manually with `CRON_SECRET`, confirm 200s and expected side effects.
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

## 5. Test targets (safe, non-production)

- SFTP: a disposable directory on a Launchabl staging host (NOT a client site).
- GitHub: a new scratch repo (e.g. `launchabl/marketr-smoke`), deleted after.
- WordPress: a staging WP install with an application password.
- Webflow: a test workspace + API token.
- Vercel/Cloudflare: tokens scoped to test projects; tear down deployments after.

## 6. Rollback

- Every milestone is a git commit; tag the deploy: `git tag deploy-2026-09-21 && git push` — **no, vault rule:**
  tags stay local too. Rollback = `git checkout <previous-commit> && docker compose up -d --build`.
- Database: restore from the nightly `pg_dump`. Migrations are forward-only; a code rollback with a
  newer DB schema is safe as long as no migration is reverted (none planned).

## 7. Out of scope for this deploy

Public launch, Product Hunt, public GitHub repo, billing/Stripe wiring, SSO against a real IdP,
KMS provider implementation, SOC 2 evidence gathering. Those follow after the internal beta proves
the loop.

---

## Decisions needed from Tico

1. **VPS provider** — default to Hetzner unless you prefer otherwise.
2. **Domain/subdomain** — default `marketr.launchabl.com`.
3. **API keys** — DataForSEO + one LLM key, via Secure Vault when you're ready.
4. **Test targets** — which staging SFTP host / WP install / Webflow workspace to point at.
5. **Timing** — say the word and the §1a volume fix + full runbook gets executed.
