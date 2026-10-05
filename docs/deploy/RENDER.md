# ShapesOS on Render

<!-- BEGIN render-env (generated: node scripts/deploy/render-env.mjs --write) -->

**shapesos-shared** (web and worker)

```dotenv
# Needed before the first deploy
MARKETR_S3_ENDPOINT=   # https://<ACCOUNT_ID>.r2.cloudflarestorage.com
MARKETR_S3_ACCESS_KEY=   # R2 API token (Object Read & Write, this bucket only)
MARKETR_S3_SECRET_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=   # images, transcription, extraction and model failover
RESEND_API_KEY=   # system mail (invites, magic links) and newsletter on the platform domain
INVITE_MAIL_FROM=   # e.g. ShapesOS <team@shapesos.com> on a Resend-verified domain
ZERNIO_API_KEY=
E2B_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_PRICE_STARTER=
STRIPE_PRICE_PRO=
STRIPE_PRICE_BUSINESS=
STRIPE_PRICE_AGENCY=
MARKETR_PLATFORM_OPERATORS=   # your user id or email: who may run host-wide operations

# When you turn the feature on (leave out otherwise)
DATAFORSEO_LOGIN=
DATAFORSEO_PASSWORD=
SERPER_API_KEY=
CONTEXTDEV_API_KEY=
SMTP_HOST=   # only if you send system mail over SMTP instead of Resend
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
ENRICHMENT_PROVIDERS=   # e.g. apollo,hunter once those keys are set (default fake is refused in production)
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
GITHUB_APP_PRIVATE_KEY=   # PEM with \n escapes
EXPO_ACCESS_TOKEN=
PUSH_PROVIDER=   # expo, once the mobile app ships
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_CLOUD_URL=
LIVEKIT_CLOUD_API_KEY=
LIVEKIT_CLOUD_API_SECRET=
VOICE_LIVEKIT_MODE=   # cloud once LIVEKIT_CLOUD_* are set (default rehearsal)
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
GUSTO_ENVIRONMENT=   # production only when you mean to run real payroll (default demo)
MESSAGING_INBOUND_EMAIL_DOMAIN=
MARKETR_CREDENTIALS_KEY_PREVIOUS=   # only during a credential key rotation
SENTRY_DSN=
OTEL_EXPORTER_OTLP_ENDPOINT=
MESSAGING_EMAIL_FROM=
MESSAGING_SMS_PROVIDER=
MESSAGING_SMS_FROM=
BOOKING_MAIL_FROM=
CALLS_PROVIDER=   # callrail once CALLRAIL_* are set (the fake default is refused in production)
CALLRAIL_PROVIDER=
CALLRAIL_API_KEY=
DUB_BASE_URL=
FLEET_CONTACT_URL=
```

**shapesos-web** (web service only)

```dotenv
# Needed before the first deploy
STRIPE_WEBHOOK_SECRET=   # from the Stripe webhook pointed at https://app.shapesos.com/api/billing/webhook

# When you turn the feature on (leave out otherwise)
GOOGLE_CLIENT_ID=   # Sign in with Google (redirect https://app.shapesos.com/api/auth/callback/google)
GOOGLE_CLIENT_SECRET=
RESEND_WEBHOOK_SECRET=
RESEND_INBOUND_WEBHOOK_SECRET=
SLACK_SIGNING_SECRET=
GITHUB_WEBHOOK_SECRET=
DOCUMENSO_WEBHOOK_SECRET=
SMARTLEAD_WEBHOOK_SECRET=
INSTANTLY_WEBHOOK_SECRET=
MARKETR_GBP_WEBHOOK_SECRET=
ADMIN_EMAIL=   # optional break-glass owner login; use a generated 20+ char password
ADMIN_PASSWORD=
LOGIN_BREAK_GLASS_IPS=
CAPTCHA_PROVIDER=   # turnstile (Cloudflare) recommended
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

<details><summary>Not set on Render, on purpose (211 keys)</summary>

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
| hosted deployment | `MARKETR_SELF_HOSTED` |
| default http://127.0.0.1:$PORT is right | `CRON_RUNNER_ORIGIN` |
| set per service in render.yaml (heap sized to the plan) | `NODE_OPTIONS` |
| local disk path; hosted files live in R2 (MARKETR_STORAGE=s3) | `MARKETR_STORAGE_DIR` |
| legacy fallback for AUTH_SECRET; leave unset so there is one session secret | `NEXTAUTH_SECRET` |
| OpenAI-compatible override; OPENAI_API_KEY is used on hosted | `LLM_API_KEY` |
| default https://api.openai.com/v1 | `LLM_BASE_URL` |
| default OpenAI endpoint | `OPENAI_BASE_URL` |
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
| local disk path; on hosted, files live in shared object storage (MARKETR_STORAGE=s3) | `FIX_SNAPSHOT_DIR`, `REPORT_STORAGE_DIR`, `SITE_STORAGE_DIR`, `AUDIO_BRIEF_STORAGE_DIR`, `EDDM_BRIEF_STORAGE_DIR`, `IO_BRIEF_STORAGE_DIR`, `LAUNCH_PACKET_STORAGE_DIR`, `SITEMAP_STORAGE_DIR`, `SANDBOX_SNAPSHOT_DIR`, `CORPUS_DIR`, `CC_GRAPH_DIR` |
| Docker sandbox settings; hosted sandboxes run on E2B | `SANDBOX_IMAGE`, `SANDBOX_CPUS`, `SANDBOX_MEMORY_MB`, `SANDBOX_PIDS`, `SANDBOX_DISK_MB`, `SANDBOX_IDLE_MINUTES`, `SANDBOX_EGRESS_ALLOW`, `SANDBOX_PREVIEW_BIND`, `SANDBOX_PREVIEW_HOST`, `SANDBOX_SNAPSHOT_MAX_MB` |
| default is right (change in the dashboard only to tune) | `AGENT_INLINE_BUDGET_SECONDS`, `AGENT_WORKER_POLL_MS`, `AGENT_JOB_LEASE_SECONDS`, `AGENT_JOB_HEARTBEAT_SECONDS`, `AGENT_JOB_MAX_ATTEMPTS`, `AGENT_MAX_STEPS`, `AGENT_MAX_RUN_MINUTES`, `AGENT_MAX_RUN_COST_MICRO_USD`, `AGENT_COMPACT_AT_TOKENS`, `AGENT_TOOL_RESULT_MAX_CHARS`, `AGENT_FIX_CYCLES`, `LLM_MODEL_COPY`, `LLM_MODEL_BULK`, `LLM_MODEL_BACKGROUND`, `LLM_MODEL_LEAD`, `LLM_MODEL_SUBAGENT`, `LLM_MODEL_CODE`, `LLM_MODEL_CODE_MAX`, `LEARNING_LOOKBACK_DAYS`, `LEARNING_MAX_EPISODES`, `LEARNING_SIMILARITY_THRESHOLD`, `LEARNING_DECAY_DAYS`, `LEARNING_DECAY_CONFIDENCE`, `LEARNING_CONSOLIDATE_MAX_WORKSPACES` |
| dev, test or demo only; never in production | `E2E_BASE_URL`, `E2E_ADMIN_EMAIL`, `E2E_EDITOR_EMAIL`, `E2E_MOCK_OAUTH`, `SEED_EMAIL`, `MEMORY_TEST_MODE`, `GRAPH_WEBHOOK_TEST_SECRETS`, `OPS_SCRATCH`, `EVAL_HUMAN`, `EVAL_RESULTS_PATH`, `EVAL_WORKSPACE_ID`, `HOME`, `FONTCONFIG_FILE`, `FAKE_MESSAGING_SECRET`, `FAKE_MAIL_SECRET`, `FAKE_CALLRAIL_SECRET`, `FAKE_TELEPHONY_SECRET` |
| opt-in live smoke tests (scripts/live, GitHub secrets); never read by the app | `LIVE_ONLY`, `LIVE_DEPLOY_WRITE`, `LIVE_GITHUB_TOKEN`, `LIVE_GITHUB_REPO`, `LIVE_GITHUB_BRANCH`, `LIVE_WORDPRESS_URL`, `LIVE_WORDPRESS_USER`, `LIVE_WORDPRESS_APP_PASSWORD`, `LIVE_WEBFLOW_TOKEN`, `LIVE_WEBFLOW_SITE_ID`, `LIVE_VERCEL_TOKEN`, `LIVE_VERCEL_TEAM_ID`, `LIVE_VERCEL_PROJECT`, `LIVE_CLOUDFLARE_TOKEN`, `LIVE_CLOUDFLARE_ACCOUNT_ID`, `LIVE_CLOUDFLARE_PROJECT`, `LIVE_NETLIFY_TOKEN`, `LIVE_NETLIFY_SITE_ID`, `LIVE_ANTHROPIC_API_KEY`, `LIVE_ANTHROPIC_MODEL` |

</details>

<!-- END render-env -->
