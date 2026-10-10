# ShapesOS on Render

How the full product (the website at `shapesos.com` and the OS at `app.shapesos.com`) runs on Render, and the exact steps to set it up, release it, roll it back and restore it. Owner decision (2026-10-05): Render now, AWS-ready from day one ([AWS.md](AWS.md) is the move). The short list of what only the owner can do is [OWNER-CHECKLIST.md](OWNER-CHECKLIST.md). Self-hosting on one machine with Docker Compose is [DEPLOY.md](../../DEPLOY.md).

Everything here is in the repo:

| File | What it is |
|---|---|
| `render.yaml` | The Blueprint: services, database, env groups. Validated in CI against Render's JSON schema (`scripts/ci/validate-render-blueprint.mjs`). |
| `scripts/deploy/render-env.mjs` | Where every env var lives. Writes the env groups in `render.yaml` and the "Values you paste" block below; fails CI on an unclassified key. |
| `.github/workflows/release.yml` + `docker-bake.hcl` | Build the images, push to GHCR, migrate, deploy, smoke test, roll back. |
| `scripts/deploy/render-release.mjs` | The deploy step (Render API). |
| `scripts/deploy/with-runtime-env.sh` | Start wrapper: builds `DATABASE_URL` for the least-privilege role. |
| `scripts/ops/backup.sh` | Nightly copy of Render's database export to R2. |

## How it fits together

```
Cloudflare (DNS, proxy, SSL Full (strict), rate-limit rule)
   │ shapesos.com (website)        │ app.shapesos.com (the OS)
   └──────────────► shapesos-web (runner image, 2–4 instances, /api/health/live)
                          │ private network
                    shapesos-worker (worker image: agent jobs)
                          │
   collab.shapesos.com ► shapesos-collab (worker image: live co-editing, ONE instance, wss)
                          │
                    shapesos-db (Postgres 16, 2 CPU / 8 GB, private only, PITR 7 days)
   shapesos-migrate (migrate image, one-off job per release) ─┘
   shapesos-backup  (nightly: Render export → R2)
   Cloudflare R2: shapesos-files (uploads, reports, recordings), shapesos-backups, shapesos-desktop
```

- **One web service serves both hosts.** `proxy.ts` sends OS pages asked for on `shapesos.com` to `app.shapesos.com` (308) and website pages asked for on `app.shapesos.com` back (308); `/` on the app host goes to `/dashboard` (307). `/api`, auth and OAuth callbacks, assets and public share pages are never redirected, and tenant domains are never touched (`lib/hosting/host-routing.ts`). Register every OAuth callback on `https://app.shapesos.com`.
- **The app never connects as the database owner.** Owners skip `FORCE ROW LEVEL SECURITY`. Only `shapesos-migrate` gets the owner's connection string. Web and worker get the database's private host and the `shapesos_app` role, and `with-runtime-env.sh` composes `DATABASE_URL` at start (Render has no variable interpolation: [blueprint spec](https://render.com/docs/blueprint-spec#variable-interpolation)).
- **Migrations run before the new code.** `release.yml` deploys the `migrate:<sha>` image to `shapesos-migrate` and runs `sh scripts/db/migrate.sh` there as a [one-off job](https://render.com/docs/one-off-jobs). A failed migration stops the release; web and worker keep running the old version. Render's [pre-deploy command](https://render.com/docs/deploys#pre-deploy-command) also works with prebuilt images, but it runs inside the service's own image: the runner image has no Prisma CLI, and the worker would then hold the owner's credentials at run time.
- **Images are prebuilt.** Render Blueprints can't pick a Dockerfile target, so `release.yml` builds `runner`, `worker`, `migrate` and `backup` and pushes them to `ghcr.io/villain336/shapesos-<target>:<sha>`. [Image-backed services never auto-deploy](https://render.com/docs/deploying-an-image#triggering-a-deploy); every release deploys an exact sha tag, so a rollback pulls exactly that image.
- **No shared disk.** Files go to R2 through the S3 adapter (`MARKETR_STORAGE=s3`). Render disks block scaling and zero-downtime deploys ([scaling](https://render.com/docs/scaling)).
- **No Redis.** Nothing in the app reads `REDIS_URL`.

## 1. Accounts

1. **Render**: create a Pro workspace (autoscaling, 7-day point-in-time recovery and per-service log streams need Pro: [scaling](https://render.com/docs/scaling), [recovery](https://render.com/docs/postgresql-backups), [log streams](https://render.com/docs/log-streams)). Turn on 2FA. Install Render's GitHub app on `Villain336/ShapesOS` (Blueprints read `render.yaml` from the repo).
2. **Cloudflare**: the `shapesos.com` zone (nameservers moved to Cloudflare) and R2.
3. **GitHub**: the repo already exists. Packages (GHCR) come with it.
4. **Providers**: Anthropic, OpenAI, Stripe, Resend, E2B, Zernio first (needed at launch, see step 7); the rest when you turn the feature on.

## 2. GitHub settings

1. **Actions minutes / spending limit**: Settings → Billing → Actions. The `verify` job sat unassigned on #23/#24 (`runner_id: 0`); fix the limit first, or nothing builds.
2. **Environment `production`**: Settings → Environments → New environment → `production`:
   - Required reviewers: you.
   - Deployment branches and tags: Selected branches → `main`.
3. **Secret** (Settings → Secrets and variables → Actions → Secrets): `RENDER_API_KEY` — Render → Account settings → API keys → Create.
4. **Variables** (same page → Variables), filled in after step 5:
   - `RENDER_WEB_SERVICE_ID` (`srv-…`), `RENDER_WORKER_SERVICE_ID` (`srv-…`), `RENDER_MIGRATE_SERVICE_ID` (`crn-…`): the id is in each service's dashboard URL.
   - `RENDER_COLLAB_SERVICE_ID` (`srv-…` of `shapesos-collab`, Phase 18.2): optional; while it is unset `release.yml` skips the collab deploy.
   - `APP_URL`: `https://app.shapesos.com`.

## 3. Let Render pull the images (GHCR credential)

GHCR packages of a private repo are private. Render needs a credential ([private images](https://render.com/docs/deploying-an-image#credentials-for-private-images)):

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate. Scope: `read:packages` only. No expiry, or put a renewal reminder in your calendar.
2. Render → Workspace settings → Container Registry Credentials → Add credential:
   - Name: `ghcr-shapesos` (render.yaml refers to this name).
   - Registry: GitHub Container Registry. Username: your GitHub username. Token: the token from 1.

## 4. Build the first images

The Blueprint pulls `:latest` on its first apply, so the images must exist before step 5. A dry run pushes only `:<sha>`, so use a real run and hold it at the approval:

1. Actions → release → Run workflow → branch `main`, **dry run unchecked**.
2. The `build` job pushes `ghcr.io/villain336/shapesos-{runner,worker,migrate,backup}` with `:<sha>` and `:latest` (Packages on the repo shows all four).
3. The `deploy` job then waits for your approval in the `production` environment. **Leave it waiting** (approvals wait up to 30 days); you approve it in step 10, once the Blueprint exists and the variables are set.

## 5. Apply the Blueprint

1. Render → New → Blueprint → pick `Villain336/ShapesOS`, branch `main`. Render reads `render.yaml` and lists 4 services, 1 database and 4 env groups.
2. It asks for the `sync: false` values of `shapesos-backup` (`RENDER_POSTGRES_ID`, `RENDER_API_KEY`, `BACKUP_S3_*`). You can leave them empty now and set them in step 12; Render only prompts on the first apply ([spec](https://render.com/docs/blueprint-spec#prompting-for-secret-values)).
3. Apply. Render creates the database (private network only: `ipAllowList: []`), generates the secrets marked `generateValue` (session secret, credential key, cron and signing secrets, the app-role password), and starts the services from `:latest`.
4. The first web/worker start fails until the database role exists and the keys are pasted. That is expected: do steps 6–7, then step 10.
5. Copy the three service ids into the GitHub variables (step 2.4).

**Copy the generated `MARKETR_CREDENTIALS_KEY` into your password manager now** (env group `shapesos-shared`). Every stored connector credential is encrypted with it; a database restore without it keeps the rows but not the credentials.

## 6. Database: extensions and the app role

Nothing to do by hand; the migrate job does it on every release. What happens, and how to check it:

- **Extensions.** The migrations run `CREATE EXTENSION` for `vector`, `pg_trgm`, `pgcrypto` and `btree_gist`. All four are supported on Render Postgres 13+ and the default user can create them ([extensions](https://render.com/docs/postgresql-extensions)).
- **The app role.** `scripts/db/migrate.sh` then runs `scripts/db/create-app-role.sql` with `APP_DB_USER=shapesos_app` and the generated `APP_DB_PASSWORD` (env group `shapesos-db-app`): a `LOGIN NOSUPERUSER NOBYPASSRLS` role with table grants only. Render's default user is not a superuser; PostgreSQL 16 doesn't let a non-superuser even name `SUPERUSER` in `ALTER ROLE`, so the script now only re-asserts those attributes when run by a superuser, and fails if the role could bypass row-level security. Tested against a simulated Render owner (LOGIN CREATEROLE CREATEDB, not superuser) on PostgreSQL 16.14.
- **Check after the first release** (Render → shapesos-db → Shell, or `psql` with the external URL after adding your IP to the database's allow list):
  ```sql
  SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'shapesos_app';  -- f | f
  SELECT extname FROM pg_extension ORDER BY 1;  -- btree_gist, pg_trgm, pgcrypto, plpgsql, vector
  ```
- **If `CREATE ROLE` is refused** (Render changed the default user's rights): the migrate job fails with `permission denied to create role`. Do not use Render's "New default credential": that user becomes the database's *default* user, so the owner URL the migrate service gets would switch to it ([credentials](https://render.com/docs/postgresql-credentials)). Ask Render support to create `shapesos_app` (`LOGIN NOSUPERUSER NOBYPASSRLS`) with the password from `shapesos-db-app`, then re-run the release; the script only refreshes grants after that.
- **Connections**: 2c-8g allows 200. Web (2–4 instances) and worker use Prisma's default pool per process; watch `pg_stat_activity` and add Render's PgBouncer (`connectionPool: pgbouncer`) only if it gets tight — transaction pooling keeps `SET LOCAL` but not session advisory locks; the cron runner uses transaction-level locks (`pg_try_advisory_xact_lock`), so it still works.

## 7. Values you paste

Render ignores `sync: false` inside env groups ([spec](https://render.com/docs/blueprint-spec#environment-groups)), so the keys only you can provide are not in `render.yaml`. Paste them into the env group named above each block (Render → Env Groups → the group → Add environment variable, or "Add from .env" where offered), or in one go from a local file:

```sh
# a file OUTSIDE the repo, KEY=value lines from the blocks below
RENDER_API_KEY=… node scripts/deploy/render-env.mjs push --file ~/shapesos-render.env --dry-run
RENDER_API_KEY=… node scripts/deploy/render-env.mjs push --file ~/shapesos-render.env
```

`push` only accepts the keys listed here, prints key names, never values, and writes through `PUT /v1/env-groups/{id}/env-vars/{key}`. A Blueprint sync never removes a variable it doesn't mention ([environment variables](https://render.com/docs/blueprint-spec#setting-environment-variables)), so pasted values survive every sync. Never put a customer's own key here: workspaces add their keys in Settings → Providers. The source of each key is in [KEYS.md](../KEYS.md).

<!-- BEGIN render-env (generated: node scripts/deploy/render-env.mjs --write) -->

**shapesos-shared** (web and worker)

```dotenv
# Needed before the first deploy
# https://<ACCOUNT_ID>.r2.cloudflarestorage.com
MARKETR_S3_ENDPOINT=
# R2 API token (Object Read & Write, this bucket only)
MARKETR_S3_ACCESS_KEY=
MARKETR_S3_SECRET_KEY=
ANTHROPIC_API_KEY=
# images, transcription, extraction and model failover
OPENAI_API_KEY=
# system mail (invites, magic links) and newsletter on the platform domain
RESEND_API_KEY=
# e.g. ShapesOS <team@shapesos.com> on a Resend-verified domain
INVITE_MAIL_FROM=
ZERNIO_API_KEY=
E2B_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_PRICE_STARTER=
STRIPE_PRICE_PRO=
STRIPE_PRICE_BUSINESS=
STRIPE_PRICE_AGENCY=
# your user id or email: who may run host-wide operations
MARKETR_PLATFORM_OPERATORS=

# When you turn the feature on (leave out otherwise)
DATAFORSEO_LOGIN=
DATAFORSEO_PASSWORD=
SERPER_API_KEY=
CONTEXTDEV_API_KEY=
# only if you send system mail over SMTP instead of Resend
SMTP_HOST=
SMTP_PORT=
SMTP_SECURE=
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
MOZ_ACCESS_ID=
MOZ_SECRET_KEY=
OPENPAGERANK_API_KEY=
YELP_API_KEY=
M3_LICENSED_NEWS_PROVIDER=
M3_NEWSAPI_KEY=
PAGESPEED_API_KEY=
APOLLO_API_KEY=
HUNTER_API_KEY=
# e.g. apollo,hunter once those keys are set (default fake is refused in production)
ENRICHMENT_PROVIDERS=
BRANDFETCH_API_KEY=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
PEXELS_API_KEY=
PIXABAY_API_KEY=
UNSPLASH_ACCESS_KEY=
COMPOSIO_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_API_KEY=
TWILIO_API_SECRET=
GITHUB_APP_ID=
# PEM with \n escapes
GITHUB_APP_PRIVATE_KEY=
EXPO_ACCESS_TOKEN=
# expo, once the mobile app ships
PUSH_PROVIDER=
# generateVapidKeys() in lib/push/vapid.ts (see .env.example)
VAPID_PUBLIC_KEY=
# the pair's private half
VAPID_PRIVATE_KEY=
# mailto: or https: contact for the push services
VAPID_SUBJECT=
# Brave Search API key for Ask; unset = labelled mock results
BRAVE_SEARCH_API_KEY=
# Exa API key for Ask; unset = that provider is skipped
EXA_API_KEY=
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_CLOUD_URL=
LIVEKIT_CLOUD_API_KEY=
LIVEKIT_CLOUD_API_SECRET=
# cloud once LIVEKIT_CLOUD_* are set (default rehearsal)
VOICE_LIVEKIT_MODE=
STRIPE_PRICE_STARTER_ANNUAL=
STRIPE_PRICE_PRO_ANNUAL=
STRIPE_PRICE_BUSINESS_ANNUAL=
STRIPE_PRICE_AGENCY_ANNUAL=
STRIPE_PRICE_SEAT_STARTER=
STRIPE_PRICE_SEAT_PRO=
STRIPE_PRICE_SEAT_BUSINESS=
STRIPE_PRICE_SEAT_AGENCY=
STRIPE_PRICE_SEAT_STARTER_ANNUAL=
STRIPE_PRICE_SEAT_PRO_ANNUAL=
STRIPE_PRICE_SEAT_BUSINESS_ANNUAL=
STRIPE_PRICE_SEAT_AGENCY_ANNUAL=
TALORDATA_API_KEY=
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_ADS_DEVELOPER_TOKEN=
META_OAUTH_CLIENT_ID=
META_OAUTH_CLIENT_SECRET=
MICROSOFT_OAUTH_CLIENT_ID=
MICROSOFT_OAUTH_CLIENT_SECRET=
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
LINEAR_OAUTH_CLIENT_ID=
LINEAR_OAUTH_CLIENT_SECRET=
ATLASSIAN_OAUTH_CLIENT_ID=
ATLASSIAN_OAUTH_CLIENT_SECRET=
AIRTABLE_OAUTH_CLIENT_ID=
AIRTABLE_OAUTH_CLIENT_SECRET=
NOTION_OAUTH_CLIENT_ID=
NOTION_OAUTH_CLIENT_SECRET=
WEBFLOW_OAUTH_CLIENT_ID=
WEBFLOW_OAUTH_CLIENT_SECRET=
BUFFER_OAUTH_CLIENT_ID=
BUFFER_OAUTH_CLIENT_SECRET=
AMAZON_ADS_CLIENT_ID=
AMAZON_ADS_CLIENT_SECRET=
AMAZON_ADS_REGION=
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
QUICKBOOKS_CLIENT_ID=
QUICKBOOKS_CLIENT_SECRET=
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
GUSTO_CLIENT_ID=
GUSTO_CLIENT_SECRET=
# production only when you mean to run real payroll (default demo)
GUSTO_ENVIRONMENT=
MESSAGING_INBOUND_EMAIL_DOMAIN=
# only during a credential key rotation
MARKETR_CREDENTIALS_KEY_PREVIOUS=
SENTRY_DSN=
OTEL_EXPORTER_OTLP_ENDPOINT=
MESSAGING_EMAIL_FROM=
MESSAGING_SMS_PROVIDER=
MESSAGING_SMS_FROM=
BOOKING_MAIL_FROM=
# callrail once CALLRAIL_* are set (the fake default is refused in production)
CALLS_PROVIDER=
CALLRAIL_PROVIDER=
CALLRAIL_API_KEY=
DUB_BASE_URL=
FLEET_CONTACT_URL=
```

**shapesos-web** (web service only)

```dotenv
# Needed before the first deploy
# from the Stripe webhook pointed at https://app.shapesos.com/api/billing/webhook
STRIPE_WEBHOOK_SECRET=

# When you turn the feature on (leave out otherwise)
# Sign in with Google (redirect https://app.shapesos.com/api/auth/callback/google)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
RESEND_WEBHOOK_SECRET=
RESEND_INBOUND_WEBHOOK_SECRET=
SLACK_SIGNING_SECRET=
GITHUB_WEBHOOK_SECRET=
DOCUMENSO_WEBHOOK_SECRET=
SMARTLEAD_WEBHOOK_SECRET=
INSTANTLY_WEBHOOK_SECRET=
MARKETR_GBP_WEBHOOK_SECRET=
# optional break-glass owner login; use a generated 20+ char password
ADMIN_EMAIL=
ADMIN_PASSWORD=
LOGIN_BREAK_GLASS_IPS=
# turnstile (Cloudflare) recommended
CAPTCHA_PROVIDER=
CAPTCHA_SITE_KEY=
CAPTCHA_SECRET_KEY=
OIDC_ISSUER=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_DISPLAY_NAME=
SAML_ENABLED=
BOXYHQ_SAML_ISSUER=
BOXYHQ_SAML_CLIENT_ID=
BOXYHQ_SAML_CLIENT_SECRET=
SSO_DOMAIN=
SSO_WORKSPACE_ID=
SSO_DEFAULT_ROLE=
```

Render generates these once, on the first Blueprint apply: `APP_DB_PASSWORD` (shapesos-db-app), `CRON_SECRET` (shapesos-web), `REMINDERS_CRON_SECRET` (shapesos-web), `AUTH_SECRET` (shapesos-shared), `MARKETR_CREDENTIALS_KEY` (shapesos-shared), `MARKETR_APPROVAL_SECRET` (shapesos-shared), `AUTHORITY_APPROVAL_SECRET` (shapesos-shared), `MESSAGING_UNSUBSCRIBE_SECRET` (shapesos-shared), `MESSAGING_INBOUND_EMAIL_SECRET` (shapesos-shared), `PAYLOAD_SECRET` (shapesos-shared), `PIXEL_SIGNING_SECRET` (shapesos-shared), `SRA_SIGNING_SECRET` (shapesos-shared), `ACTION_OAUTH_STATE_SECRET` (shapesos-shared), `CALLRAIL_WEBHOOK_SECRET` (shapesos-web).

<details><summary>Not set on Render, on purpose (259 keys)</summary>

| Why | Keys |
|---|---|
| AWS migrate task only (infra/aws); Render's migrate job gets the owner URL directly | `SHAPESOS_DB_OWNER_USER` |
| AWS migrate task only (infra/aws) | `SHAPESOS_DB_OWNER_PASSWORD` |
| AWS only: Secrets Manager blobs (infra/aws); Render uses env groups | `SHAPESOS_ENV_JSON_SHARED`, `SHAPESOS_ENV_JSON_WEB`, `SHAPESOS_ENV_JSON_WORKER` |
| docker compose only (Render creates the owner user) | `POSTGRES_USER` |
| docker compose only | `POSTGRES_PASSWORD`, `POSTGRES_DB`, `MINIO_ROOT_PASSWORD`, `MINIO_IMAGE`, `APP_BIND_ADDR` |
| docker compose only (files go to Cloudflare R2) | `MINIO_ROOT_USER` |
| docker compose only (Render sets PORT) | `APP_PORT` |
| nothing in the app reads it; no Redis on Render | `REDIS_URL` |
| local + docker compose only (the worker starts the collab server on it); on Render shapesos-collab listens on the PORT Render sets | `COLLAB_PORT` |
| hosted deployment | `MARKETR_SELF_HOSTED` |
| default http://127.0.0.1:$PORT is right | `CRON_RUNNER_ORIGIN` |
| set per service in render.yaml (heap sized to the plan) | `NODE_OPTIONS` |
| default 120 reads/min per person per web instance; set it in shapesos-web only if many people share one IP | `RATE_LIMIT_READ_PER_MIN` |
| local disk path; hosted files live in R2 (MARKETR_STORAGE=s3) | `MARKETR_STORAGE_DIR` |
| legacy fallback for AUTH_SECRET; leave unset so there is one session secret | `NEXTAUTH_SECRET` |
| OpenAI-compatible override; OPENAI_API_KEY is used on hosted | `LLM_API_KEY` |
| default https://api.openai.com/v1 | `LLM_BASE_URL` |
| default OpenAI endpoint | `OPENAI_BASE_URL` |
| only for a self-hosted push service | `WEB_PUSH_EXTRA_HOSTS` |
| default 256 is right | `SNAPSHOT_MAX_MB` |
| default is right: the server browser (Playwright); set server-http only where no browser is installed | `AGENTWEB_PROVIDER` |
| default gpt-image-2 is right | `LLM_IMAGE_MODEL` |
| default vendor price is right | `DATAFORSEO_PRICE_PER_1K`, `SERPER_PRICE_PER_1K`, `TALORDATA_PRICE_PER_1K` |
| default production is right | `QUICKBOOKS_ENVIRONMENT` |
| pinned default is right | `SHOPIFY_API_VERSION`, `GUSTO_API_VERSION`, `GOOGLE_ADS_API_VERSION`, `META_GRAPH_API_VERSION` |
| migration switch for old self-host installs only | `CALLRAIL_WEBHOOK_ACCEPT_SHARED_SECRET` |
| default open is right for hosted; set invite during a private beta | `SIGNUP_MODE` |
| default 3 is right | `LOGIN_CAPTCHA_AFTER_FAILURES` |
| env (default); aws-kms is a documented stub | `SECRETS_PROVIDER` |
| only for SECRETS_PROVIDER=aws-kms (not used on Render) | `AWS_REGION` |
| only for SECRETS_PROVIDER=aws-kms | `AWS_KMS_KEY_ID` |
| the build commit (MARKETR_GIT_COMMIT) identifies the release | `SENTRY_RELEASE` |
| tracing is off unless the endpoint is set | `OTEL_SDK_DISABLED` |
| default info is right | `LOG_LEVEL` |
| baked into the runner image by release.yml (build arg) | `MARKETR_GIT_COMMIT` |
| GBP management stays off until Google approves the API application | `GBP_API_KEY` |
| demo instances only | `SOCIAL_MOCK_MODE` |
| default 9.5 is right | `SOCIAL_MAX_UPLOAD_MB` |
| default off; webhooks are used | `GITHUB_PR_POLL` |
| default resend is right | `MESSAGING_EMAIL_PROVIDER` |
| each workspace connects its own sender on hosted | `OUTREACH_SENDING_PROVIDER` |
| bring-your-own on hosted (docs/KEYS.md: env key is the self-host fallback) | `SMARTLEAD_API_KEY` |
| bring-your-own on hosted | `INSTANTLY_API_KEY`, `SMARTLEAD_RELAY_CAMPAIGN_IDS`, `INSTANTLY_RELAY_CAMPAIGN_IDS` |
| default memory; no Redis on Render | `MCP_RATE_LIMITER` |
| default is right | `MEDIA_CARD_MODE`, `ACTION_APPROVAL_TTL_MS`, `GRAPH_CONNECTORS_LIVE`, `MARKETR_MAX_BROWSER_RECORDINGS`, `MEDIA_TWO_PERSON_THRESHOLD_CENTS`, `MEDIA_EXECUTION_WINDOW_HOURS`, `LLM_TIMEOUT_MS` |
| no ClamAV sidecar on Render | `CLAMAV_HOST`, `CLAMAV_PORT` |
| default Telegram API | `TELEGRAM_API_BASE` |
| the test lab stays dry-run unless you decide otherwise | `TESTLAB_REAL_SEND` |
| default Composio endpoint | `COMPOSIO_BASE_URL` |
| self-host sidecar | `PENPOT_BASE_URL`, `PENPOT_ACCESS_TOKEN` |
| not used on hosted | `NANGO_SECRET_KEY`, `NEMO_DATA_DESIGNER_ENDPOINT` |
| OPENAI_API_KEY covers extraction on hosted | `EXTRACTION_API_KEY` |
| OPENAI_API_KEY covers transcription on hosted | `TRANSCRIPTION_API_KEY` |
| default endpoint | `TRANSCRIPTION_BASE_URL` |
| default model | `TRANSCRIPTION_MODEL` |
| local VoiceStudio engine; not on hosted | `VOICESTUDIO_URL` |
| real outbound calling stays off until decided | `LIVE_DIALING` |
| no WeasyPrint in the runner image | `MARKETR_WEASYPRINT_PYTHON` |
| local corpus path | `MARKETR_EXPERT_CORPUS` |
| dev crawl switch | `CC_GRAPH_CRAWL` |
| co-located BriefNow runtime only | `BRIEFNOW_ADAPTERS_ROOT` |
| default 90 is right | `DATASET_STALE_AFTER_DAYS` |
| the memory pass runs as the app role with in-session budgets (no extra DB login on Render) | `MEMORY_WORKER_ROLE` |
| default cache dir | `MEMORY_MODEL_CACHE` |
| default on: meaning-search uses the cached local MiniLM | `SPOTLIGHT_SEMANTIC` |
| default on: uploads index their text in the background | `SPOTLIGHT_INDEX_ON_WRITE` |
| default 200 per search-index cron run is right | `SEARCH_INDEX_BATCH` |
| demo/test only | `POS_TERMINAL_MOCK` |
| bring-your-own media buying | `VIBE_CLIENT_ID`, `VIBE_CLIENT_SECRET`, `VIBE_API_TOKEN` |
| default test mode stays on | `VIBE_TEST_MODE` |
| prototype flag, off | `MARKETR_LDE_PROTOTYPE` |
| default https://zernio.com/api | `ZERNIO_BASE_URL` |
| default e2b.app | `E2B_DOMAIN` |
| default base | `E2B_TEMPLATE` |
| E2B is the hosted sandbox provider | `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_SNAPSHOT` |
| no Docker socket on Render; sandboxes run on E2B | `DOCKER_HOST` |
| deprecated | `LLM_MODEL` |
| default 0 keeps zero-retention routing | `LLM_ALLOW_RETENTION_MODELS` |
| hosted uses provider APIs | `LLM_SELF_HOST` |
| default on with both keys | `LLM_FAILOVER` |
| dev benchmark only | `BENCH_MODEL` |
| self-host-or-your-own: the env instance is refused on hosted; workspaces connect their own (docs/KEYS.md) | `POSTIZ_URL`, `POSTIZ_API_KEY`, `LISTMONK_URL`, `LISTMONK_USER`, `LISTMONK_TOKEN`, `PLANE_BASE_URL`, `PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG`, `GHOST_URL`, `GHOST_ADMIN_API_KEY`, `DOCUMENSO_URL`, `DOCUMENSO_API_KEY`, `GROWTHBOOK_API_HOST`, `GROWTHBOOK_API_KEY`, `GROWTHBOOK_CLIENT_KEY`, `UMAMI_URL`, `UMAMI_API_KEY`, `UMAMI_WEBSITE_ID`, `UMAMI_SCRIPT_URL`, `CHATWOOT_BASE_URL`, `CHATWOOT_WEBSITE_TOKEN`, `CHATWOOT_WIDGET_ENABLED`, `ACTIVEPIECES_URL`, `ACTIVEPIECES_API_KEY`, `ACTIVEPIECES_API_PREFIX` |
| pg_dump mode only; on Render the backup job uses BACKUP_SOURCE=render-export (the owner can't pg_dump FORCE-RLS tables there) | `BACKUP_DATABASE_URL` |
| --loop mode only; Render's cron schedule runs one backup per day | `BACKUP_INTERVAL_SECONDS` |
| default 3600 is right | `BACKUP_EXPORT_TIMEOUT_SECONDS` |
| default 15 is right | `BACKUP_EXPORT_POLL_SECONDS` |
| tests only (backup.sh against a fake Render API) | `RENDER_API_BASE` |
| local disk path; on hosted, files live in shared object storage (MARKETR_STORAGE=s3) | `FIX_SNAPSHOT_DIR`, `SNAPSHOT_STORAGE_DIR`, `REPORT_STORAGE_DIR`, `SITE_STORAGE_DIR`, `AUDIO_BRIEF_STORAGE_DIR`, `EDDM_BRIEF_STORAGE_DIR`, `IO_BRIEF_STORAGE_DIR`, `LAUNCH_PACKET_STORAGE_DIR`, `SITEMAP_STORAGE_DIR`, `SANDBOX_SNAPSHOT_DIR`, `CORPUS_DIR`, `CC_GRAPH_DIR` |
| Docker sandbox settings; hosted sandboxes run on E2B | `SANDBOX_IMAGE`, `SANDBOX_CPUS`, `SANDBOX_MEMORY_MB`, `SANDBOX_PIDS`, `SANDBOX_DISK_MB`, `SANDBOX_IDLE_MINUTES`, `SANDBOX_EGRESS_ALLOW`, `SANDBOX_PREVIEW_BIND`, `SANDBOX_PREVIEW_HOST`, `SANDBOX_SNAPSHOT_MAX_MB` |
| default is right (change in the dashboard only to tune) | `AGENT_INLINE_BUDGET_SECONDS`, `AGENT_WORKER_POLL_MS`, `AGENT_JOB_LEASE_SECONDS`, `AGENT_JOB_HEARTBEAT_SECONDS`, `AGENT_JOB_MAX_ATTEMPTS`, `AGENT_MAX_STEPS`, `AGENT_MAX_RUN_MINUTES`, `AGENT_MAX_RUN_COST_MICRO_USD`, `AGENT_COMPACT_AT_TOKENS`, `AGENT_TOOL_RESULT_MAX_CHARS`, `AGENT_FIX_CYCLES`, `LLM_MODEL_COPY`, `LLM_MODEL_BULK`, `LLM_MODEL_BACKGROUND`, `LLM_MODEL_LEAD`, `LLM_MODEL_SUBAGENT`, `LLM_MODEL_CODE`, `LLM_MODEL_CODE_MAX`, `LEARNING_LOOKBACK_DAYS`, `LEARNING_MAX_EPISODES`, `LEARNING_SIMILARITY_THRESHOLD`, `LEARNING_DECAY_DAYS`, `LEARNING_DECAY_CONFIDENCE`, `LEARNING_CONSOLIDATE_MAX_WORKSPACES`, `DESK_BRIEFING_MAX_MEMBERS`, `AGENT_CONTEXT_EDIT_AT_TOKENS`, `LLM_BATCH` |
| evaluation knobs (scripts/eval); unset = the measured defaults | `LLM_EFFORT_LEAD`, `LLM_EFFORT_SUBAGENT`, `LLM_EFFORT_CODE`, `LLM_EFFORT_CODE_MAX`, `LLM_EFFORT_COPY`, `LLM_EFFORT_BULK`, `LLM_EFFORT_BACKGROUND`, `CHAT_CACHE_LAYOUT` |
| the Anthropic SDK's own override; only the test fake and the eval dry run set it | `ANTHROPIC_BASE_URL` |
| local-disk blob root; hosted runs MARKETR_STORAGE=s3 | `MARKETR_BLOB_DIR` |
| Render uses the MARKETR_S3_* keys for R2; on AWS the ECS task role supplies credentials | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` |
| set by ECS itself for the task role; never set by hand | `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN` |
| defaults (25 s / 8 s) fit Render's and ECS's 30 s stop timeout | `SHUTDOWN_GRACE_MS`, `SHUTDOWN_HANDOFF_MS` |
| Prisma's default pool fits 2-4 web replicas + a worker on the 200-connection plan (docs/deploy/RENDER.md §6); set it only when pg_stat_activity gets tight | `DATABASE_POOL_SIZE` |
| default on (warm the recall embedder at boot) | `MEMORY_WARM_AT_BOOT` |
| the latency battery (scripts/verify/latency.mts) only; never read by the app | `LATENCY_RUNS`, `LATENCY_SLACK`, `LATENCY_STRICT`, `LATENCY_ASSERT`, `LATENCY_BASE_URL`, `LATENCY_PORT`, `LATENCY_DEV`, `LATENCY_LOG_DIR`, `LATENCY_APP_DATABASE_URL` |
| dev, test or demo only; never in production | `E2E_BASE_URL`, `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, `E2E_EDITOR_EMAIL`, `SMOKE_APP_DATABASE_URL`, `SMOKE_PORT_A`, `SMOKE_PORT_B`, `SMOKE_GRACE_MS`, `SMOKE_REAL_S3`, `SMOKE_SKIP_WORKER`, `E2E_MOCK_OAUTH`, `SEED_EMAIL`, `MEMORY_TEST_MODE`, `GRAPH_WEBHOOK_TEST_SECRETS`, `OPS_SCRATCH`, `EVAL_HUMAN`, `EVAL_RESULTS_PATH`, `EVAL_WORKSPACE_ID`, `HOME`, `FONTCONFIG_FILE`, `FAKE_MESSAGING_SECRET`, `FAKE_MAIL_SECRET`, `FAKE_CALLRAIL_SECRET`, `FAKE_TELEPHONY_SECRET` |
| opt-in live smoke tests (scripts/live, GitHub secrets); never read by the app | `LIVE_ONLY`, `LIVE_DEPLOY_WRITE`, `LIVE_GITHUB_TOKEN`, `LIVE_GITHUB_REPO`, `LIVE_GITHUB_BRANCH`, `LIVE_WORDPRESS_URL`, `LIVE_WORDPRESS_USER`, `LIVE_WORDPRESS_APP_PASSWORD`, `LIVE_WEBFLOW_TOKEN`, `LIVE_WEBFLOW_SITE_ID`, `LIVE_VERCEL_TOKEN`, `LIVE_VERCEL_TEAM_ID`, `LIVE_VERCEL_PROJECT`, `LIVE_CLOUDFLARE_TOKEN`, `LIVE_CLOUDFLARE_ACCOUNT_ID`, `LIVE_CLOUDFLARE_PROJECT`, `LIVE_NETLIFY_TOKEN`, `LIVE_NETLIFY_SITE_ID`, `LIVE_ANTHROPIC_API_KEY`, `LIVE_ANTHROPIC_MODEL` |

</details>

<!-- END render-env -->

## 8. Cloudflare R2: buckets

1. R2 → Create bucket, location automatic:
   - `shapesos-files` — private. Uploads, reports, recordings.
   - `shapesos-backups` — private. Add a lifecycle rule: delete objects under `render/` after 35 days.
   - `shapesos-desktop` — desktop installers and update feeds (Phase 19A). Connect a custom domain (`downloads.shapesos.com`) under Settings → Public access when the desktop app ships.
2. R2 → Manage API tokens → Create API token: Object Read & Write, **specific buckets** `shapesos-files`. Paste the access key id and secret as `MARKETR_S3_ACCESS_KEY` / `MARKETR_S3_SECRET_KEY`, and `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` as `MARKETR_S3_ENDPOINT` ([R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/): region `auto`, which `render.yaml` sets).
3. A second token, Object Read & Write on `shapesos-backups` only, for the backup job (step 12).
4. **CORS**: none needed today — the app reads and writes R2 server-side; browsers never talk to the bucket. If a later change hands browsers presigned URLs, add a rule on `shapesos-files` allowing `GET`/`PUT` from `https://app.shapesos.com` only.

## 9. Domains and Cloudflare

1. `render.yaml` already adds `shapesos.com` and `app.shapesos.com` to `shapesos-web` (Render also adds `www.shapesos.com` redirecting to the root: [custom domains](https://render.com/docs/custom-domains)).
2. Cloudflare → DNS ([Render's Cloudflare guide](https://render.com/docs/configure-cloudflare-dns)):
   - Delete any `AAAA` records for these names (Render is IPv4 only).
   - `CNAME @ → shapesos-web.onrender.com`, `CNAME www → shapesos-web.onrender.com`, `CNAME app → shapesos-web.onrender.com`, all **DNS only** (grey cloud) for now.
3. Render → shapesos-web → Settings → Custom Domains → Verify each. Wait until the certificates show as issued.
4. Then switch the three records to **Proxied** (orange cloud), and Cloudflare → SSL/TLS → Overview → **Full (strict)**. Render's guide says Full; strict also works because Render serves a valid certificate for each verified domain, and it refuses a man in the middle between Cloudflare and Render. If you see error 525/526, set Full and tell me.
5. Rate limit on sign-in (Security → WAF → Rate limiting rules; the Free plan has one rule, matching on Path, per IP, 10-second period: [rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/)):
   - If: URI Path starts with `/api/auth/`.
   - Rate: 20 requests per 10 seconds per IP → Block for 10 seconds. The app limits sign-in too (10/min per IP, lockouts in Postgres); this stops floods before they reach Render.
6. **Client IPs.** `TRUSTED_PROXY_HOPS=2` (env group `shapesos-web`) reads the client from `X-Forwarded-For: <client>, <edge>` (the form Render documents for its own Cloudflare edge: [DDoS protection](https://render.com/articles/how-render-handles-ddos-attacks)). With your own Cloudflare proxy in front, check it once after the first deploy: open `https://app.shapesos.com/login` and sign in with a wrong password, then on shapesos-db run `SELECT key FROM rate_limit_buckets WHERE key LIKE 'auth:ip:%';` — it must show *your* public IP. A Cloudflare address means one more hop (set 3); `auth:ip:no-ip` means fewer (set 1). Wrong values put every visitor in one rate-limit bucket.
7. **Tenant custom domains** (white label). Customers CNAME their domain to `domains.shapesos.com`:
   - Now: Cloudflare → `CNAME domains → shapesos-web.onrender.com`, **DNS only**.
   - Per tenant domain, ShapesOS adds it to `shapesos-web` with `POST /v1/services/{id}/custom-domains {"name": "reviews.acme.com"}` and Render issues its certificate. That automation ships with the white-label serving work (today the app stores the domain but does not serve it, `app/api/workspaces/white-label/route.ts`). Pro includes 15 custom domains, then $0.25/month each.
   - **Cloudflare for SaaS is not recommended in front of Render**: Render's own edge is Cloudflare, and a custom-hostname fallback origin on Render has been reported to fail with Cloudflare error 1000 ("DNS points to prohibited IP"). On AWS, CloudFront's SaaS Manager does this job ([AWS.md](AWS.md)). Because tenants point at `domains.shapesos.com`, moving providers never touches their DNS.
8. Optional, once everything works: `renderSubdomainPolicy: disabled` on `shapesos-web` so `shapesos-web.onrender.com` stops answering.

## 10. First deploy

1. Steps 5–9 done, GitHub variables (step 2.4) set.
2. Open the waiting release run from step 4 and approve `production` (or start a new run on `main` with dry run unchecked; automatic releases stay off until you set the repository variable `RELEASE_ENABLED=true`; after that, every merge to `main` starts `release` by itself once `ci` passes, and waits for your approval).
3. The deploy job logs each step: rollback targets → migrate image live → migrate job `succeeded` → worker live → web live → smoke `https://app.shapesos.com/api/health → 200 ok, commit <sha>`.
4. Check by hand:
   - `https://shapesos.com` shows the website; `https://shapesos.com/login` lands on `https://app.shapesos.com/login`.
   - Sign in, open a workspace, upload a file, open it again (it lives in R2).
   - Render → shapesos-web → Logs: `in-app cron runner started`; Settings → Providers → Scheduled jobs (platform operator) shows `ok` rows after a few minutes.
   - Run an agent chat that takes more than 45 seconds: it hands off to `shapesos-worker` (worker logs show the job).
   - Client IP check from step 9.6.

## 11. Rollback

- **Automatic**: if the worker or web deploy fails, or the smoke test doesn't see the new commit within 5 minutes, `render-release.mjs` rolls both back to the deploys that were live before ([rollback API](https://render.com/docs/rollbacks)) and the job fails.
- **By hand**: Render → shapesos-web (then shapesos-worker) → Deploys → pick the last good deploy → Rollback. Rolling back an image-backed service pulls that deploy's image again, so it must still be in GHCR: don't delete old package versions ([rollbacks](https://render.com/docs/rollbacks#registry-hosted-docker-images)).
- **Migrations are forward-only.** A rollback runs the previous code on the new schema, which is why migrations are written expand-then-contract (add columns and tables first; drop them a release later).
- A bad migration: fix forward with a new migration. If data was damaged, restore (step 12) into a new database and switch.

## 12. Backups and the restore drill

What protects the data:

1. **Point-in-time recovery**, the last 7 days on Pro ([recovery](https://render.com/docs/postgresql-backups)): shapesos-db → Recovery → Restore Database creates a *new* database at the time you choose; check it, then point the services at it.
2. **Render's logical exports** (kept 7 days; Recovery → Create export).
3. **A nightly copy off Render**: `shapesos-backup` (03:17 UTC) asks Render for an export, waits, checks it unpacks, and uploads it to R2 `shapesos-backups/render/` (`scripts/ops/backup.sh`, `BACKUP_SOURCE=render-export`). It can't use `pg_dump` here: Render's owner user has no `BYPASSRLS`, and `pg_dump` stops at the first `FORCE ROW LEVEL SECURITY` table (tested). Set on shapesos-backup → Environment:
   - `RENDER_POSTGRES_ID`: the `dpg-…` id from shapesos-db's URL.
   - `RENDER_API_KEY`: a Render API key (it can act on the whole workspace; keep it only here and in GitHub).
   - `BACKUP_S3_ENDPOINT` (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`), `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` (the backups-only token from step 8.3).
   - Trigger one run now (Cron Jobs → shapesos-backup → Trigger run) and check the object in R2.

Restore drill (quarterly, and after major upgrades):

1. shapesos-db → Recovery → Restore Database → a time 1 hour ago → name `shapesos-db-drill`.
2. When it's available, add your IP to its allow list and connect with its external URL.
3. Check: `SELECT count(*) FROM workspaces;`, `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;` match production; `rolsuper`/`rolbypassrls` of `shapesos_app` are `f`.
4. Also restore last night's R2 copy into an empty local database, following [BACKUP-RESTORE.md](../ops/BACKUP-RESTORE.md) ("Render exports").
5. Delete `shapesos-db-drill`. Write the date and counts into BACKUP-RESTORE.md.

## 13. Uptime, logs and alerts

- **Uptime**: an external monitor (Better Stack, UptimeRobot, …) on `https://app.shapesos.com/api/health` every minute — readiness: database reachable and every migration applied; it answers 503 otherwise. Render itself restarts an instance whose `/api/health/live` fails for 60 seconds ([health checks](https://render.com/docs/health-checks)).
- **Logs**: Render → Integrations → Observability → Log Streams → default destination (syslog TLS or HTTPS to your log provider). Streams don't count as bandwidth ([log streams](https://render.com/docs/log-streams)). The app logs one JSON line per event.
- **Errors**: set `SENTRY_DSN` (shared group) for error reports; `OTEL_EXPORTER_OTLP_ENDPOINT` for traces.
- **Notifications**: Workspace settings → Notifications → deploy failures and service events to email or Slack.

## Live collaboration (Phase 18.2)

Notes are co-edited live through a Hocuspocus (yjs WebSocket) server, `scripts/collab.mts` → `lib/collab/server.ts`, on the worker image.

- **Where it runs: its own web service, `shapesos-collab`, not the worker.** Browsers open a WebSocket to it, and a Render background worker takes no inbound traffic ([background workers](https://render.com/docs/background-workers)); the web service exposes one port and is the Next app, so it can't host a second server either. Locally and in Docker Compose the same server runs as the `collab` service (or inside the worker when `COLLAB_PORT` is set).
- **Exactly one instance** (`numInstances: 1`, no autoscaling). Hocuspocus shares a document across processes only through its Redis extension; there is no Redis here. Postgres is the durable store: the yjs state (`univer_doc_collab_states`) and the note's JSON snapshot (`univer_docs.snapshot`) are written 2 s after typing stops (at most every 10 s), so a restart loses at most the last few seconds of keystrokes and every editor reconnects.
- **Domain**: add `collab.shapesos.com` (CNAME to the service, like `app.`). The web service's `COLLAB_PUBLIC_URL` (env group `shapesos-web`) is `wss://collab.shapesos.com`. Cloudflare proxies WebSockets on every plan; the editors' awareness pings keep the connection busy well inside its 100 s idle limit.
- **Auth**: the app mints a 5-minute token per connection (`/api/collab/token`, signed with the shared `AUTH_SECRET`), naming one note and whether the connection may write; viewers' connections are read-only on the server.
- **Deploys and shutdown**: `release.yml` deploys the worker image to it after the worker (`--collab-service`). On SIGTERM it stores every live document, then closes the connections; editors reconnect to the new instance on their own (`maxShutdownDelaySeconds: 60`).
- **Health**: `GET /health` → `{ ok, documents, connections }`.

## 14. Scaling and build capacity

- **Web**: autoscaled 2–4 instances at 70 % CPU (`render.yaml`). Raise `maxInstances`, or the plan (`2c-4g` → `4c-8g`), there.
- **Worker**: `numInstances` in `render.yaml` (claims never collide); `AGENT_WORKER_CONCURRENCY` (env group `shapesos-worker`, default 6) for more jobs per instance.
- **Database**: `plan: 2c-8g` → `4c-16g` (400 connections). Read replicas and high availability (`highAvailability: enabled`, Pro workspace) when uptime needs it.
- **Long requests**: Render allows HTTP responses up to 100 minutes ([Render vs Vercel](https://render.com/docs/render-vs-vercel-comparison)); Cloudflare closes a proxied connection idle for ~100 s, which the SSE heartbeats (every 15 s) prevent.
- **Shutdown**: `maxShutdownDelaySeconds` is 120 s on web and 300 s (the maximum) on worker: Render sends SIGTERM, waits, then SIGKILL ([deploys](https://render.com/docs/deploys#graceful-shutdown)).
- **Build capacity**: images build on a standard GitHub runner (2 CPUs, 8 GB, 14 GB SSD for a private repo: [runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)) with the CI memory settings (`LOW_MEMORY_BUILD=1` in `docker-bake.hcl`: no Turbopack source maps or disk cache, no second type check), plus extra swap (`scripts/ci/add-swap.sh`) because the compile peaks at ~10–14 GB: past 8 GB it pages out instead of killing the runner, at some cost in build time. If the build outgrows it: a larger runner (GitHub Team or Enterprise), or a Render Docker build of the `runner` target with a Performance build pipeline, or CodeBuild on AWS. Production stack traces need source maps: set `LOW_MEMORY_BUILD=""` once the runner has ~13 GB.

## 15. HIPAA, and when to move to AWS

- Render HIPAA needs a Scale or Enterprise workspace, a signed BAA, and adds 20 % to all usage; enabling it is irreversible and moves every service to restricted hosts ([HIPAA](https://render.com/docs/hipaa-compliance)). Never process PHI outside that workspace.
- The AWS triggers (owner decision): the first deal that needs a HIPAA BAA, data residency or a VPC; a customer who needs a fixed outbound IP; or a bill above about $2,000/month. Then follow [AWS.md](AWS.md): same images, same env plan, same migrations.

## Clean-up

- Disconnect the Netlify site and the Cloudflare Workers/Pages builds from the repo: both fail by design (the app needs an always-on server, a worker and advisory locks).
- Keep the Cloudflare account for DNS, R2 and the rate-limit rule.
- `docs/migration/CLOUDFLARE-PLAN.md` predates the worker, SSE and sandboxes; retire it.

## Verified, and still to prove live

Checked against vendor docs on 2026-10-05: Blueprint fields and the [JSON schema](https://render.com/schema/render.yaml.json); prebuilt images, GHCR credentials and `imageUrl` deploys; one-off jobs; rollback API; deploy and job statuses ([API](https://api-docs.render.com)); `sync: false` ignored in env groups; extensions; PITR 7 days on Pro; health checks; custom domains; Cloudflare setup; log streams; HIPAA terms; GitHub runner sizes; R2 region `auto`; Cloudflare rate-limit plan limits.

Not provable from here (no Render account, no Docker daemon): the image builds, the first Blueprint apply, Render's default user creating the role (simulated locally), `push` against the real API, the export download in `shapesos-backup`, client IPs behind Cloudflare + Render (step 9.6), Full (strict) through Render's edge, and tenant domains through a CNAME chain.
