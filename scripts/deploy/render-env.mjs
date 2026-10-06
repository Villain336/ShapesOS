#!/usr/bin/env node
// ShapesOS — where every environment variable lives on Render (deploy PR).
//
// The single source of truth for the Render env groups. Every key in
// .env.example is classified here exactly once (a unit test fails when a new
// key is added to .env.example without a decision), and this script writes:
//   1. the `envVarGroups:` section of render.yaml (fixed values and
//      generated secrets only — Render ignores `sync: false` inside env
//      groups, https://render.com/docs/blueprint-spec#environment-groups);
//   2. the "Values you paste" block of docs/deploy/RENDER.md: one .env-style
//      list per group of the secrets/settings only the owner can provide,
//      plus the keys deliberately not set on hosted, with the reason.
//
//   node scripts/deploy/render-env.mjs --write   regenerate both files
//   node scripts/deploy/render-env.mjs --check   exit 1 if either is stale or
//                                                .env.example has an unclassified key
//   node scripts/deploy/render-env.mjs push --file <path> [--dry-run]
//        put the values from a local .env-style file into the right Render env
//        groups via the Render API (PUT /v1/env-groups/{id}/env-vars/{key},
//        https://api-docs.render.com/reference/update-env-group-env-var).
//        Needs RENDER_API_KEY. Prints key names only, never values. Refuses
//        keys this table doesn't mark as owner-pasted.
//
// Classes:
//   value     fixed, non-secret value written into render.yaml
//   generate  `generateValue: true` in render.yaml (random 256-bit base64,
//             created once, never overwritten by later Blueprint syncs)
//   paste     the owner pastes it (secrets and account-specific settings);
//             `need: "launch"` = required before the first deploy
//   service   set per service in render.yaml (database references), not in a group
//   exclude   not set on hosted Render; `why` says why (default is right,
//             compose-only, dev/test only, refused on hosted, …)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The public URL of the OS (Render custom domain app.shapesos.com). */
export const APP_ORIGIN = "https://app.shapesos.com";

export const GROUPS = {
  "shapesos-db-app": "Runtime database role (web, worker and the migrate job)",
  "shapesos-shared": "Web and worker",
  "shapesos-web": "Web service only",
  "shapesos-worker": "Worker only",
};

const S = "shapesos-shared";
const W = "shapesos-web";
const K = "shapesos-worker";
const D = "shapesos-db-app";

// ---------------------------------------------------------------------------
// The table. [key, spec]. Keep entries grouped by purpose.
// ---------------------------------------------------------------------------
/** @type {Array<[string, {cls: string, group?: string, value?: string, need?: "launch", why?: string, notInEnvExample?: string}]>} */
export const TABLE = [
  // --- database: composed per service, never pasted ----------------------
  ["DATABASE_URL", { cls: "service", why: "web/worker: composed at start from the shapesos-db-app role and the database's private host (scripts/deploy/with-runtime-env.sh); migrate job: the owner's connection string from the database" }],
  ["APP_DB_USER", { cls: "value", group: D, value: "shapesos_app" }],
  ["APP_DB_PASSWORD", { cls: "generate", group: D }],
  ["SHAPESOS_DB_HOST", { cls: "service", why: "fromDatabase host (private network)" }],
  ["SHAPESOS_DB_PORT", { cls: "service", why: "fromDatabase port" }],
  ["SHAPESOS_DB_NAME", { cls: "service", why: "fromDatabase database" }],
  ["SHAPESOS_DB_OWNER_USER", { cls: "exclude", why: "AWS migrate task only (infra/aws); Render's migrate job gets the owner URL directly" }],
  ["SHAPESOS_DB_OWNER_PASSWORD", { cls: "exclude", why: "AWS migrate task only (infra/aws)" }],
  ["SHAPESOS_ENV_JSON_SHARED", { cls: "exclude", why: "AWS only: Secrets Manager blobs (infra/aws); Render uses env groups" }],
  ["SHAPESOS_ENV_JSON_WEB", { cls: "exclude", why: "AWS only: Secrets Manager blobs (infra/aws); Render uses env groups" }],
  ["SHAPESOS_ENV_JSON_WORKER", { cls: "exclude", why: "AWS only: Secrets Manager blobs (infra/aws); Render uses env groups" }],
  ["POSTGRES_USER", { cls: "exclude", why: "docker compose only (Render creates the owner user)" }],
  ["POSTGRES_PASSWORD", { cls: "exclude", why: "docker compose only" }],
  ["POSTGRES_DB", { cls: "exclude", why: "docker compose only" }],
  ["MINIO_ROOT_USER", { cls: "exclude", why: "docker compose only (files go to Cloudflare R2)" }],
  ["MINIO_ROOT_PASSWORD", { cls: "exclude", why: "docker compose only" }],
  ["MINIO_IMAGE", { cls: "exclude", why: "docker compose only" }],
  ["APP_BIND_ADDR", { cls: "exclude", why: "docker compose only" }],
  ["APP_PORT", { cls: "exclude", why: "docker compose only (Render sets PORT)" }],
  ["REDIS_URL", { cls: "exclude", why: "nothing in the app reads it; no Redis on Render" }],

  // --- URLs and hosts ----------------------------------------------------
  ["NEXTAUTH_URL", { cls: "value", group: S, value: APP_ORIGIN }],
  ["AUTH_URL", { cls: "value", group: S, value: APP_ORIGIN }],
  ["APP_URL", { cls: "value", group: S, value: APP_ORIGIN }],
  ["APP_PUBLIC_URL", { cls: "value", group: S, value: APP_ORIGIN }],
  ["APP_BASE_URL", { cls: "value", group: S, value: APP_ORIGIN }],
  ["MARKETR_BASE_URL", { cls: "value", group: S, value: APP_ORIGIN }],
  ["NEXT_PUBLIC_APP_URL", { cls: "value", group: S, value: APP_ORIGIN, why: "also baked into the runner image at build time (release.yml build-arg): Next inlines NEXT_PUBLIC_* during next build" }],
  ["WEBSITE_HOST", { cls: "value", group: W, value: "shapesos.com" }],
  ["APP_HOST", { cls: "value", group: W, value: "app.shapesos.com" }],
  ["TRUSTED_PROXY_HOPS", { cls: "value", group: W, value: "2", why: "Render's edge sends X-Forwarded-For: <client>, <edge> (verify on the first deploy, RENDER.md step 9)" }],
  ["MARKETR_SELF_HOSTED", { cls: "exclude", why: "hosted deployment" }],
  ["DEPLOYMENT_MODE", { cls: "value", group: S, value: "hosted" }],

  // --- runtime topology ---------------------------------------------------
  ["CRON_RUNNER", { cls: "value", group: W, value: "internal", why: "every web replica ticks; a Postgres advisory lock lets one claim each slot" }],
  ["CRON_RUNNER_ORIGIN", { cls: "exclude", why: "default http://127.0.0.1:$PORT is right" }],
  ["CRON_SECRET", { cls: "generate", group: W }],
  ["REMINDERS_CRON_SECRET", { cls: "generate", group: W }],
  ["AGENT_WORKER", { cls: "value", group: W, value: "external", why: "only shapesos-worker claims agent jobs" }],
  ["AGENT_WORKER_CONCURRENCY", { cls: "value", group: K, value: "6" }],
  ["KEEP_ALIVE_TIMEOUT", { cls: "value", group: W, value: "310000", why: "above every load balancer idle timeout in front of the app" }],
  ["NODE_OPTIONS", { cls: "exclude", notInEnvExample: "Node runtime flag, set per service in render.yaml", why: "set per service in render.yaml (heap sized to the plan)" }],
  ["RATE_LIMIT_STORE", { cls: "value", group: S, value: "postgres" }],
  ["MARKETR_STORAGE", { cls: "value", group: S, value: "s3" }],
  ["MARKETR_S3_REGION", { cls: "value", group: S, value: "auto", why: "R2's region (https://developers.cloudflare.com/r2/api/s3/api/)" }],
  ["MARKETR_S3_BUCKET", { cls: "value", group: S, value: "shapesos-files" }],
  ["MARKETR_S3_FORCE_PATH_STYLE", { cls: "value", group: S, value: "true" }],
  ["MARKETR_S3_ENDPOINT", { cls: "paste", group: S, need: "launch", why: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" }],
  ["MARKETR_S3_ACCESS_KEY", { cls: "paste", group: S, need: "launch", why: "R2 API token (Object Read & Write, this bucket only)" }],
  ["MARKETR_S3_SECRET_KEY", { cls: "paste", group: S, need: "launch" }],
  ["MARKETR_STORAGE_DIR", { cls: "exclude", why: "local disk path; hosted files live in R2 (MARKETR_STORAGE=s3)" }],
  ["SANDBOX_PROVIDER", { cls: "value", group: S, value: "e2b" }],
  ["ALLOW_FAKE_PROVIDERS", { cls: "value", group: S, value: "0" }],
  ["ALLOW_UNSIGNED_WEBHOOKS", { cls: "value", group: S, value: "false" }],
  ["SENTRY_ENVIRONMENT", { cls: "value", group: S, value: "production" }],
  ["OTEL_SERVICE_NAME", { cls: "value", group: S, value: "shapesos" }],

  // --- secrets ShapesOS generates itself (Render generateValue) ----------
  ["AUTH_SECRET", { cls: "generate", group: S }],
  ["NEXTAUTH_SECRET", { cls: "exclude", why: "legacy fallback for AUTH_SECRET; leave unset so there is one session secret" }],
  ["MARKETR_CREDENTIALS_KEY", { cls: "generate", group: S, why: "32 random bytes as base64 (lib/sitefiles/crypto.ts accepts it). Copy it into your password manager: losing it loses every stored connector credential" }],
  ["MARKETR_APPROVAL_SECRET", { cls: "generate", group: S }],
  ["AUTHORITY_APPROVAL_SECRET", { cls: "generate", group: S }],
  ["MESSAGING_UNSUBSCRIBE_SECRET", { cls: "generate", group: S }],
  ["MESSAGING_INBOUND_EMAIL_SECRET", { cls: "generate", group: S }],
  ["PAYLOAD_SECRET", { cls: "generate", group: S }],
  ["PIXEL_SIGNING_SECRET", { cls: "generate", group: S }],
  ["SRA_SIGNING_SECRET", { cls: "generate", group: S }],
  ["ACTION_OAUTH_STATE_SECRET", { cls: "generate", group: S }],
  ["CALLRAIL_WEBHOOK_SECRET", { cls: "generate", group: W, why: "host secret each workspace's webhook secret is derived from" }],

  // --- platform keys (docs/KEYS.md "Platform" / "Both") -------------------
  ["ANTHROPIC_API_KEY", { cls: "paste", group: S, need: "launch" }],
  ["OPENAI_API_KEY", { cls: "paste", group: S, need: "launch", why: "images, transcription, extraction and model failover" }],
  ["LLM_API_KEY", { cls: "exclude", why: "OpenAI-compatible override; OPENAI_API_KEY is used on hosted" }],
  ["LLM_BASE_URL", { cls: "exclude", why: "default https://api.openai.com/v1" }],
  ["OPENAI_BASE_URL", { cls: "exclude", why: "default OpenAI endpoint" }],
  ["DATAFORSEO_LOGIN", { cls: "paste", group: S }],
  ["DATAFORSEO_PASSWORD", { cls: "paste", group: S }],
  ["SERPER_API_KEY", { cls: "paste", group: S }],
  ["CONTEXTDEV_API_KEY", { cls: "paste", group: S }],
  ["RESEND_API_KEY", { cls: "paste", group: S, need: "launch", why: "system mail (invites, magic links) and newsletter on the platform domain" }],
  ["INVITE_MAIL_FROM", { cls: "paste", group: S, need: "launch", why: "e.g. ShapesOS <team@shapesos.com> on a Resend-verified domain" }],
  ["SMTP_HOST", { cls: "paste", group: S, why: "only if you send system mail over SMTP instead of Resend" }],
  ["SMTP_PORT", { cls: "paste", group: S }],
  ["SMTP_SECURE", { cls: "paste", group: S }],
  ["SMTP_USER", { cls: "paste", group: S }],
  ["SMTP_PASS", { cls: "paste", group: S }],
  ["SMTP_FROM", { cls: "paste", group: S }],
  ["MOZ_ACCESS_ID", { cls: "paste", group: S }],
  ["MOZ_SECRET_KEY", { cls: "paste", group: S }],
  ["OPENPAGERANK_API_KEY", { cls: "paste", group: S }],
  ["YELP_API_KEY", { cls: "paste", group: S }],
  ["M3_LICENSED_NEWS_PROVIDER", { cls: "paste", group: S }],
  ["M3_NEWSAPI_KEY", { cls: "paste", group: S }],
  ["PAGESPEED_API_KEY", { cls: "paste", group: S }],
  ["APOLLO_API_KEY", { cls: "paste", group: S }],
  ["HUNTER_API_KEY", { cls: "paste", group: S }],
  ["ENRICHMENT_PROVIDERS", { cls: "paste", group: S, why: "e.g. apollo,hunter once those keys are set (default fake is refused in production)" }],
  ["BRANDFETCH_API_KEY", { cls: "paste", group: S }],
  ["CLOUDINARY_CLOUD_NAME", { cls: "paste", group: S }],
  ["CLOUDINARY_API_KEY", { cls: "paste", group: S }],
  ["CLOUDINARY_API_SECRET", { cls: "paste", group: S }],
  ["PEXELS_API_KEY", { cls: "paste", group: S }],
  ["PIXABAY_API_KEY", { cls: "paste", group: S }],
  ["UNSPLASH_ACCESS_KEY", { cls: "paste", group: S }],
  ["COMPOSIO_API_KEY", { cls: "paste", group: S }],
  ["ZERNIO_API_KEY", { cls: "paste", group: S, need: "launch" }],
  ["TWILIO_ACCOUNT_SID", { cls: "paste", group: S }],
  ["TWILIO_AUTH_TOKEN", { cls: "paste", group: S }],
  ["TWILIO_API_KEY", { cls: "paste", group: S }],
  ["TWILIO_API_SECRET", { cls: "paste", group: S }],
  ["E2B_API_KEY", { cls: "paste", group: S, need: "launch" }],
  ["GITHUB_APP_ID", { cls: "paste", group: S }],
  ["GITHUB_APP_PRIVATE_KEY", { cls: "paste", group: S, why: "PEM with \\n escapes" }],
  ["EXPO_ACCESS_TOKEN", { cls: "paste", group: S }],
  ["PUSH_PROVIDER", { cls: "paste", group: S, why: "expo, once the mobile app ships" }],
  ["LIVEKIT_URL", { cls: "paste", group: S }],
  ["LIVEKIT_API_KEY", { cls: "paste", group: S }],
  ["LIVEKIT_API_SECRET", { cls: "paste", group: S }],
  ["LIVEKIT_CLOUD_URL", { cls: "paste", group: S }],
  ["LIVEKIT_CLOUD_API_KEY", { cls: "paste", group: S }],
  ["LIVEKIT_CLOUD_API_SECRET", { cls: "paste", group: S }],
  ["VOICE_LIVEKIT_MODE", { cls: "paste", group: S, why: "cloud once LIVEKIT_CLOUD_* are set (default rehearsal)" }],
  ["STRIPE_SECRET_KEY", { cls: "paste", group: S, need: "launch" }],
  ["STRIPE_WEBHOOK_SECRET", { cls: "paste", group: W, need: "launch", why: "from the Stripe webhook pointed at https://app.shapesos.com/api/billing/webhook" }],
  ["STRIPE_PRICE_STARTER", { cls: "paste", group: S, need: "launch" }],
  ["STRIPE_PRICE_PRO", { cls: "paste", group: S, need: "launch" }],
  ["STRIPE_PRICE_BUSINESS", { cls: "paste", group: S, need: "launch" }],
  ["STRIPE_PRICE_AGENCY", { cls: "paste", group: S, need: "launch" }],
  ["STRIPE_PRICE_STARTER_ANNUAL", { cls: "paste", group: S }],
  ["STRIPE_PRICE_PRO_ANNUAL", { cls: "paste", group: S }],
  ["STRIPE_PRICE_BUSINESS_ANNUAL", { cls: "paste", group: S }],
  ["STRIPE_PRICE_AGENCY_ANNUAL", { cls: "paste", group: S }],
  ["STRIPE_PRICE_SEAT_STARTER", { cls: "paste", group: S }],
  ["STRIPE_PRICE_SEAT_PRO", { cls: "paste", group: S }],
  ["STRIPE_PRICE_SEAT_BUSINESS", { cls: "paste", group: S }],
  ["STRIPE_PRICE_SEAT_AGENCY", { cls: "paste", group: S }],
  ["STRIPE_PRICE_SEAT_STARTER_ANNUAL", { cls: "paste", group: S }],
  ["STRIPE_PRICE_SEAT_PRO_ANNUAL", { cls: "paste", group: S }],
  ["STRIPE_PRICE_SEAT_BUSINESS_ANNUAL", { cls: "paste", group: S }],
  ["STRIPE_PRICE_SEAT_AGENCY_ANNUAL", { cls: "paste", group: S }],
  ["LLM_IMAGE_MODEL", { cls: "exclude", why: "default gpt-image-2 is right" }],
  ["DATAFORSEO_PRICE_PER_1K", { cls: "exclude", why: "default vendor price is right" }],
  ["SERPER_PRICE_PER_1K", { cls: "exclude", why: "default vendor price is right" }],
  ["TALORDATA_API_KEY", { cls: "paste", group: S }],
  ["TALORDATA_PRICE_PER_1K", { cls: "exclude", why: "default vendor price is right" }],

  // --- OAuth apps (docs/KEYS.md "Connect"); tokens refresh in the worker too ---
  ["GOOGLE_CLIENT_ID", { cls: "paste", group: W, why: "Sign in with Google (redirect https://app.shapesos.com/api/auth/callback/google)" }],
  ["GOOGLE_CLIENT_SECRET", { cls: "paste", group: W }],
  ["GOOGLE_OAUTH_CLIENT_ID", { cls: "paste", group: S }],
  ["GOOGLE_OAUTH_CLIENT_SECRET", { cls: "paste", group: S }],
  ["GOOGLE_ADS_DEVELOPER_TOKEN", { cls: "paste", group: S }],
  ["META_OAUTH_CLIENT_ID", { cls: "paste", group: S }],
  ["META_OAUTH_CLIENT_SECRET", { cls: "paste", group: S }],
  ["MICROSOFT_OAUTH_CLIENT_ID", { cls: "paste", group: S }],
  ["MICROSOFT_OAUTH_CLIENT_SECRET", { cls: "paste", group: S }],
  ["SLACK_CLIENT_ID", { cls: "paste", group: S }],
  ["SLACK_CLIENT_SECRET", { cls: "paste", group: S }],
  ["HUBSPOT_CLIENT_ID", { cls: "paste", group: S }],
  ["HUBSPOT_CLIENT_SECRET", { cls: "paste", group: S }],
  ["LINEAR_OAUTH_CLIENT_ID", { cls: "paste", group: S }],
  ["LINEAR_OAUTH_CLIENT_SECRET", { cls: "paste", group: S }],
  ["ATLASSIAN_OAUTH_CLIENT_ID", { cls: "paste", group: S }],
  ["ATLASSIAN_OAUTH_CLIENT_SECRET", { cls: "paste", group: S }],
  ["AIRTABLE_OAUTH_CLIENT_ID", { cls: "paste", group: S }],
  ["AIRTABLE_OAUTH_CLIENT_SECRET", { cls: "paste", group: S }],
  ["NOTION_OAUTH_CLIENT_ID", { cls: "paste", group: S }],
  ["NOTION_OAUTH_CLIENT_SECRET", { cls: "paste", group: S }],
  ["WEBFLOW_OAUTH_CLIENT_ID", { cls: "paste", group: S }],
  ["WEBFLOW_OAUTH_CLIENT_SECRET", { cls: "paste", group: S }],
  ["BUFFER_OAUTH_CLIENT_ID", { cls: "paste", group: S }],
  ["BUFFER_OAUTH_CLIENT_SECRET", { cls: "paste", group: S }],
  ["AMAZON_ADS_CLIENT_ID", { cls: "paste", group: S }],
  ["AMAZON_ADS_CLIENT_SECRET", { cls: "paste", group: S }],
  ["AMAZON_ADS_REGION", { cls: "paste", group: S }],
  ["SHOPIFY_CLIENT_ID", { cls: "paste", group: S }],
  ["SHOPIFY_CLIENT_SECRET", { cls: "paste", group: S }],
  ["QUICKBOOKS_CLIENT_ID", { cls: "paste", group: S }],
  ["QUICKBOOKS_CLIENT_SECRET", { cls: "paste", group: S }],
  ["XERO_CLIENT_ID", { cls: "paste", group: S }],
  ["XERO_CLIENT_SECRET", { cls: "paste", group: S }],
  ["GUSTO_CLIENT_ID", { cls: "paste", group: S }],
  ["GUSTO_CLIENT_SECRET", { cls: "paste", group: S }],
  ["GUSTO_ENVIRONMENT", { cls: "paste", group: S, why: "production only when you mean to run real payroll (default demo)" }],
  ["QUICKBOOKS_ENVIRONMENT", { cls: "exclude", why: "default production is right" }],
  ["SHOPIFY_API_VERSION", { cls: "exclude", why: "pinned default is right" }],
  ["GUSTO_API_VERSION", { cls: "exclude", why: "pinned default is right" }],
  ["GOOGLE_ADS_API_VERSION", { cls: "exclude", why: "pinned default is right" }],
  ["META_GRAPH_API_VERSION", { cls: "exclude", why: "pinned default is right" }],

  // --- webhook signing secrets (received on the web service) -------------
  ["RESEND_WEBHOOK_SECRET", { cls: "paste", group: W }],
  ["RESEND_INBOUND_WEBHOOK_SECRET", { cls: "paste", group: W }],
  ["MESSAGING_INBOUND_EMAIL_DOMAIN", { cls: "paste", group: S }],
  ["SLACK_SIGNING_SECRET", { cls: "paste", group: W }],
  ["GITHUB_WEBHOOK_SECRET", { cls: "paste", group: W }],
  ["DOCUMENSO_WEBHOOK_SECRET", { cls: "paste", group: W }],
  ["SMARTLEAD_WEBHOOK_SECRET", { cls: "paste", group: W }],
  ["INSTANTLY_WEBHOOK_SECRET", { cls: "paste", group: W }],
  ["MARKETR_GBP_WEBHOOK_SECRET", { cls: "paste", group: W }],
  ["CALLRAIL_WEBHOOK_ACCEPT_SHARED_SECRET", { cls: "exclude", why: "migration switch for old self-host installs only" }],

  // --- sign-in, SSO, operators (web) --------------------------------------
  ["ADMIN_EMAIL", { cls: "paste", group: W, why: "optional break-glass owner login; use a generated 20+ char password" }],
  ["ADMIN_PASSWORD", { cls: "paste", group: W }],
  ["LOGIN_BREAK_GLASS_IPS", { cls: "paste", group: W }],
  ["SIGNUP_MODE", { cls: "exclude", why: "default open is right for hosted; set invite during a private beta" }],
  ["CAPTCHA_PROVIDER", { cls: "paste", group: W, why: "turnstile (Cloudflare) recommended" }],
  ["CAPTCHA_SITE_KEY", { cls: "paste", group: W }],
  ["CAPTCHA_SECRET_KEY", { cls: "paste", group: W }],
  ["LOGIN_CAPTCHA_AFTER_FAILURES", { cls: "exclude", why: "default 3 is right" }],
  ["OIDC_ISSUER", { cls: "paste", group: W }],
  ["OIDC_CLIENT_ID", { cls: "paste", group: W }],
  ["OIDC_CLIENT_SECRET", { cls: "paste", group: W }],
  ["OIDC_DISPLAY_NAME", { cls: "paste", group: W }],
  ["SAML_ENABLED", { cls: "paste", group: W }],
  ["BOXYHQ_SAML_ISSUER", { cls: "paste", group: W }],
  ["BOXYHQ_SAML_CLIENT_ID", { cls: "paste", group: W }],
  ["BOXYHQ_SAML_CLIENT_SECRET", { cls: "paste", group: W }],
  ["SSO_DOMAIN", { cls: "paste", group: W }],
  ["SSO_WORKSPACE_ID", { cls: "paste", group: W }],
  ["SSO_DEFAULT_ROLE", { cls: "paste", group: W }],
  ["MARKETR_PLATFORM_OPERATORS", { cls: "paste", group: S, need: "launch", why: "your user id or email: who may run host-wide operations" }],
  ["MARKETR_CREDENTIALS_KEY_PREVIOUS", { cls: "paste", group: S, why: "only during a credential key rotation" }],
  ["SECRETS_PROVIDER", { cls: "exclude", why: "env (default); aws-kms is a documented stub" }],
  ["AWS_REGION", { cls: "exclude", why: "only for SECRETS_PROVIDER=aws-kms (not used on Render)" }],
  ["AWS_KMS_KEY_ID", { cls: "exclude", why: "only for SECRETS_PROVIDER=aws-kms" }],

  // --- observability -------------------------------------------------------
  ["SENTRY_DSN", { cls: "paste", group: S }],
  ["SENTRY_RELEASE", { cls: "exclude", why: "the build commit (MARKETR_GIT_COMMIT) identifies the release" }],
  ["OTEL_EXPORTER_OTLP_ENDPOINT", { cls: "paste", group: S }],
  ["OTEL_SDK_DISABLED", { cls: "exclude", why: "tracing is off unless the endpoint is set" }],
  ["LOG_LEVEL", { cls: "exclude", why: "default info is right" }],
  ["MARKETR_GIT_COMMIT", { cls: "exclude", why: "baked into the runner image by release.yml (build arg)" }],

  // --- feature settings (defaults are right; change in the dashboard only if needed) ---
  ["FEATURE_GBP_MANAGEMENT", { cls: "value", group: S, value: "false" }],
  ["GBP_API_KEY", { cls: "exclude", why: "GBP management stays off until Google approves the API application" }],
  ["SOCIAL_MOCK_MODE", { cls: "exclude", why: "demo instances only" }],
  ["SOCIAL_MAX_UPLOAD_MB", { cls: "exclude", why: "default 9.5 is right" }],
  ["GITHUB_PR_POLL", { cls: "exclude", why: "default off; webhooks are used" }],
  ["MESSAGING_EMAIL_PROVIDER", { cls: "exclude", why: "default resend is right" }],
  ["MESSAGING_EMAIL_FROM", { cls: "paste", group: S }],
  ["MESSAGING_SMS_PROVIDER", { cls: "paste", group: S }],
  ["MESSAGING_SMS_FROM", { cls: "paste", group: S }],
  ["BOOKING_MAIL_FROM", { cls: "paste", group: S }],
  ["CALLS_PROVIDER", { cls: "paste", group: S, why: "callrail once CALLRAIL_* are set (the fake default is refused in production)" }],
  ["CALLRAIL_PROVIDER", { cls: "paste", group: S }],
  ["CALLRAIL_API_KEY", { cls: "paste", group: S }],
  ["DUB_BASE_URL", { cls: "paste", group: S }],
  ["OUTREACH_SENDING_PROVIDER", { cls: "exclude", why: "each workspace connects its own sender on hosted" }],
  ["SMARTLEAD_API_KEY", { cls: "exclude", why: "bring-your-own on hosted (docs/KEYS.md: env key is the self-host fallback)" }],
  ["INSTANTLY_API_KEY", { cls: "exclude", why: "bring-your-own on hosted" }],
  ["SMARTLEAD_RELAY_CAMPAIGN_IDS", { cls: "exclude", why: "bring-your-own on hosted" }],
  ["INSTANTLY_RELAY_CAMPAIGN_IDS", { cls: "exclude", why: "bring-your-own on hosted" }],
  ["MCP_RATE_LIMITER", { cls: "exclude", why: "default memory; no Redis on Render" }],
  ["MEDIA_CARD_MODE", { cls: "exclude", why: "default is right" }],
  ["CLAMAV_HOST", { cls: "exclude", why: "no ClamAV sidecar on Render" }],
  ["CLAMAV_PORT", { cls: "exclude", why: "no ClamAV sidecar on Render" }],
  ["TELEGRAM_API_BASE", { cls: "exclude", why: "default Telegram API" }],
  ["TESTLAB_REAL_SEND", { cls: "exclude", why: "the test lab stays dry-run unless you decide otherwise" }],
  ["ACTION_APPROVAL_TTL_MS", { cls: "exclude", why: "default is right" }],
  ["COMPOSIO_BASE_URL", { cls: "exclude", why: "default Composio endpoint" }],
  ["FLEET_CONTACT_URL", { cls: "paste", group: S }],
  ["PENPOT_BASE_URL", { cls: "exclude", why: "self-host sidecar" }],
  ["PENPOT_ACCESS_TOKEN", { cls: "exclude", why: "self-host sidecar" }],
  ["NANGO_SECRET_KEY", { cls: "exclude", why: "not used on hosted" }],
  ["EXTRACTION_API_KEY", { cls: "exclude", why: "OPENAI_API_KEY covers extraction on hosted" }],
  ["TRANSCRIPTION_API_KEY", { cls: "exclude", why: "OPENAI_API_KEY covers transcription on hosted" }],
  ["TRANSCRIPTION_BASE_URL", { cls: "exclude", why: "default endpoint" }],
  ["TRANSCRIPTION_MODEL", { cls: "exclude", why: "default model" }],
  ["VOICESTUDIO_URL", { cls: "exclude", why: "local VoiceStudio engine; not on hosted" }],
  ["LIVE_DIALING", { cls: "exclude", why: "real outbound calling stays off until decided" }],
  ["MARKETR_WEASYPRINT_PYTHON", { cls: "exclude", why: "no WeasyPrint in the runner image" }],
  ["MARKETR_EXPERT_CORPUS", { cls: "exclude", why: "local corpus path" }],
  ["CC_GRAPH_CRAWL", { cls: "exclude", why: "dev crawl switch" }],
  ["GRAPH_CONNECTORS_LIVE", { cls: "exclude", why: "default is right" }],
  ["BRIEFNOW_ADAPTERS_ROOT", { cls: "exclude", why: "co-located BriefNow runtime only" }],
  ["DATASET_STALE_AFTER_DAYS", { cls: "exclude", why: "default 90 is right" }],
  ["NEMO_DATA_DESIGNER_ENDPOINT", { cls: "exclude", why: "not used on hosted" }],
  ["MEMORY_WORKER_ROLE", { cls: "exclude", why: "the memory pass runs as the app role with in-session budgets (no extra DB login on Render)" }],
  ["MEMORY_MODEL_CACHE", { cls: "exclude", why: "default cache dir" }],
  ["MARKETR_MAX_BROWSER_RECORDINGS", { cls: "exclude", why: "default is right" }],
  ["POS_TERMINAL_MOCK", { cls: "exclude", why: "demo/test only" }],
  ["VIBE_CLIENT_ID", { cls: "exclude", why: "bring-your-own media buying" }],
  ["VIBE_CLIENT_SECRET", { cls: "exclude", why: "bring-your-own media buying" }],
  ["VIBE_API_TOKEN", { cls: "exclude", why: "bring-your-own media buying" }],
  ["VIBE_TEST_MODE", { cls: "exclude", why: "default test mode stays on" }],
  ["MEDIA_TWO_PERSON_THRESHOLD_CENTS", { cls: "exclude", why: "default is right" }],
  ["MEDIA_EXECUTION_WINDOW_HOURS", { cls: "exclude", why: "default is right" }],
  ["MARKETR_LDE_PROTOTYPE", { cls: "exclude", why: "prototype flag, off" }],
  ["ZERNIO_BASE_URL", { cls: "exclude", why: "default https://zernio.com/api" }],
  ["E2B_DOMAIN", { cls: "exclude", why: "default e2b.app" }],
  ["E2B_TEMPLATE", { cls: "exclude", why: "default base" }],
  ["DAYTONA_API_KEY", { cls: "exclude", why: "E2B is the hosted sandbox provider" }],
  ["DAYTONA_API_URL", { cls: "exclude", why: "E2B is the hosted sandbox provider" }],
  ["DAYTONA_SNAPSHOT", { cls: "exclude", why: "E2B is the hosted sandbox provider" }],
  ["DOCKER_HOST", { cls: "exclude", why: "no Docker socket on Render; sandboxes run on E2B" }],
  ["LLM_MODEL", { cls: "exclude", why: "deprecated" }],
  ["LLM_ALLOW_RETENTION_MODELS", { cls: "exclude", why: "default 0 keeps zero-retention routing" }],
  ["LLM_SELF_HOST", { cls: "exclude", why: "hosted uses provider APIs" }],
  ["LLM_FAILOVER", { cls: "exclude", why: "default on with both keys" }],
  ["LLM_TIMEOUT_MS", { cls: "exclude", why: "default is right" }],
  ["BENCH_MODEL", { cls: "exclude", why: "dev benchmark only" }],

  // --- self-host-or-your-own tools: refused on hosted (docs/KEYS.md) ------
  ...[
    "POSTIZ_URL", "POSTIZ_API_KEY", "LISTMONK_URL", "LISTMONK_USER", "LISTMONK_TOKEN",
    "PLANE_BASE_URL", "PLANE_API_KEY", "PLANE_WORKSPACE_SLUG", "GHOST_URL", "GHOST_ADMIN_API_KEY",
    "DOCUMENSO_URL", "DOCUMENSO_API_KEY", "GROWTHBOOK_API_HOST", "GROWTHBOOK_API_KEY", "GROWTHBOOK_CLIENT_KEY",
    "UMAMI_URL", "UMAMI_API_KEY", "UMAMI_WEBSITE_ID", "UMAMI_SCRIPT_URL",
    "CHATWOOT_BASE_URL", "CHATWOOT_WEBSITE_TOKEN", "CHATWOOT_WIDGET_ENABLED",
    "ACTIVEPIECES_URL", "ACTIVEPIECES_API_KEY", "ACTIVEPIECES_API_PREFIX",
  ].map((k) => [k, { cls: "exclude", why: "self-host-or-your-own: the env instance is refused on hosted; workspaces connect their own (docs/KEYS.md)" }]),

  // --- backups: set on the shapesos-backup cron job in render.yaml --------
  ["BACKUP_DATABASE_URL", { cls: "exclude", why: "pg_dump mode only; on Render the backup job uses BACKUP_SOURCE=render-export (the owner can't pg_dump FORCE-RLS tables there)" }],
  ...["BACKUP_DIR", "BACKUP_RETENTION_DAYS", "BACKUP_S3_BUCKET", "BACKUP_S3_ENDPOINT", "BACKUP_S3_REGION", "BACKUP_S3_PREFIX", "BACKUP_S3_ACCESS_KEY", "BACKUP_S3_SECRET_KEY"].map(
    (k) => [k, { cls: "service", why: "shapesos-backup cron job (render.yaml)" }],
  ),
  ["BACKUP_INTERVAL_SECONDS", { cls: "exclude", why: "--loop mode only; Render's cron schedule runs one backup per day" }],
  ["BACKUP_SOURCE", { cls: "service", why: "shapesos-backup cron job (render-export)" }],
  ["BACKUP_EXPORT_TIMEOUT_SECONDS", { cls: "exclude", why: "default 3600 is right" }],
  ["BACKUP_EXPORT_POLL_SECONDS", { cls: "exclude", why: "default 15 is right" }],
  ["RENDER_API_BASE", { cls: "exclude", why: "tests only (backup.sh against a fake Render API)" }],
  ["RENDER_API_KEY", { cls: "service", why: "shapesos-backup cron job (sync: false); also the GitHub secret release.yml uses" }],
  ["RENDER_POSTGRES_ID", { cls: "service", why: "shapesos-backup cron job (sync: false)" }],

  // --- local disk paths: hosted files go to R2 (MARKETR_STORAGE=s3) ------
  ...["FIX_SNAPSHOT_DIR", "REPORT_STORAGE_DIR", "SITE_STORAGE_DIR", "AUDIO_BRIEF_STORAGE_DIR", "EDDM_BRIEF_STORAGE_DIR", "IO_BRIEF_STORAGE_DIR", "LAUNCH_PACKET_STORAGE_DIR", "SITEMAP_STORAGE_DIR", "SANDBOX_SNAPSHOT_DIR", "CORPUS_DIR", "CC_GRAPH_DIR"].map(
    (k) => [k, { cls: "exclude", why: "local disk path; on hosted, files live in shared object storage (MARKETR_STORAGE=s3)" }],
  ),

  // --- the Docker sandbox: not on Render (E2B instead) ---------------------
  ...["SANDBOX_IMAGE", "SANDBOX_CPUS", "SANDBOX_MEMORY_MB", "SANDBOX_PIDS", "SANDBOX_DISK_MB", "SANDBOX_IDLE_MINUTES", "SANDBOX_EGRESS_ALLOW", "SANDBOX_PREVIEW_BIND", "SANDBOX_PREVIEW_HOST", "SANDBOX_SNAPSHOT_MAX_MB"].map(
    (k) => [k, { cls: "exclude", why: "Docker sandbox settings; hosted sandboxes run on E2B" }],
  ),

  // --- agent loop and memory tuning: defaults are right -------------------
  ...["AGENT_INLINE_BUDGET_SECONDS", "AGENT_WORKER_POLL_MS", "AGENT_JOB_LEASE_SECONDS", "AGENT_JOB_HEARTBEAT_SECONDS", "AGENT_JOB_MAX_ATTEMPTS", "AGENT_MAX_STEPS", "AGENT_MAX_RUN_MINUTES", "AGENT_MAX_RUN_COST_MICRO_USD", "AGENT_COMPACT_AT_TOKENS", "AGENT_TOOL_RESULT_MAX_CHARS", "AGENT_FIX_CYCLES",
    "LLM_MODEL_COPY", "LLM_MODEL_BULK", "LLM_MODEL_BACKGROUND", "LLM_MODEL_LEAD", "LLM_MODEL_SUBAGENT", "LLM_MODEL_CODE", "LLM_MODEL_CODE_MAX",
    "LEARNING_LOOKBACK_DAYS", "LEARNING_MAX_EPISODES", "LEARNING_SIMILARITY_THRESHOLD", "LEARNING_DECAY_DAYS", "LEARNING_DECAY_CONFIDENCE", "LEARNING_CONSOLIDATE_MAX_WORKSPACES"].map(
    (k) => [k, { cls: "exclude", why: "default is right (change in the dashboard only to tune)" }],
  ),

  // --- deploy-state: shared storage credentials and graceful shutdown ------
  ["MARKETR_BLOB_DIR", { cls: "exclude", why: "local-disk blob root; hosted runs MARKETR_STORAGE=s3" }],
  ...["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].map(
    (k) => [k, { cls: "exclude", why: "Render uses the MARKETR_S3_* keys for R2; on AWS the ECS task role supplies credentials" }],
  ),
  ...["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN"].map(
    (k) => [k, { cls: "exclude", why: "set by ECS itself for the task role; never set by hand" }],
  ),
  ...["SHUTDOWN_GRACE_MS", "SHUTDOWN_HANDOFF_MS"].map(
    (k) => [k, { cls: "exclude", why: "defaults (25 s / 8 s) fit Render's and ECS's 30 s stop timeout" }],
  ),

  // --- Phase 17 (latency) --------------------------------------------------
  ["DATABASE_POOL_SIZE", { cls: "exclude", why: "Prisma's default pool fits 2-4 web replicas + a worker on the 200-connection plan (docs/deploy/RENDER.md §6); set it only when pg_stat_activity gets tight" }],
  ["MEMORY_WARM_AT_BOOT", { cls: "exclude", why: "default on (warm the recall embedder at boot)" }],
  ...["LATENCY_RUNS", "LATENCY_SLACK", "LATENCY_STRICT", "LATENCY_ASSERT", "LATENCY_BASE_URL", "LATENCY_PORT", "LATENCY_DEV", "LATENCY_LOG_DIR", "LATENCY_APP_DATABASE_URL"].map(
    (k) => [k, { cls: "exclude", why: "the latency battery (scripts/verify/latency.mts) only; never read by the app" }],
  ),

  // --- dev, test and eval only ------------------------------------------
  ...["E2E_BASE_URL", "E2E_ADMIN_EMAIL", "E2E_ADMIN_PASSWORD", "E2E_EDITOR_EMAIL",
    "SMOKE_APP_DATABASE_URL", "SMOKE_PORT_A", "SMOKE_PORT_B", "SMOKE_GRACE_MS", "SMOKE_REAL_S3", "SMOKE_SKIP_WORKER", "E2E_MOCK_OAUTH", "SEED_EMAIL", "MEMORY_TEST_MODE", "GRAPH_WEBHOOK_TEST_SECRETS", "OPS_SCRATCH", "EVAL_HUMAN", "EVAL_RESULTS_PATH", "EVAL_WORKSPACE_ID", "HOME", "FONTCONFIG_FILE",
    "FAKE_MESSAGING_SECRET", "FAKE_MAIL_SECRET", "FAKE_CALLRAIL_SECRET", "FAKE_TELEPHONY_SECRET"].map(
    (k) => [k, { cls: "exclude", why: "dev, test or demo only; never in production" }],
  ),
  ...["LIVE_ONLY", "LIVE_DEPLOY_WRITE", "LIVE_GITHUB_TOKEN", "LIVE_GITHUB_REPO", "LIVE_GITHUB_BRANCH", "LIVE_WORDPRESS_URL", "LIVE_WORDPRESS_USER", "LIVE_WORDPRESS_APP_PASSWORD", "LIVE_WEBFLOW_TOKEN", "LIVE_WEBFLOW_SITE_ID", "LIVE_VERCEL_TOKEN", "LIVE_VERCEL_TEAM_ID", "LIVE_VERCEL_PROJECT", "LIVE_CLOUDFLARE_TOKEN", "LIVE_CLOUDFLARE_ACCOUNT_ID", "LIVE_CLOUDFLARE_PROJECT", "LIVE_NETLIFY_TOKEN", "LIVE_NETLIFY_SITE_ID", "LIVE_ANTHROPIC_API_KEY", "LIVE_ANTHROPIC_MODEL"].map(
    (k) => [k, { cls: "exclude", why: "opt-in live smoke tests (scripts/live, GitHub secrets); never read by the app" }],
  ),
];

// ---------------------------------------------------------------------------

export function tableMap() {
  const m = new Map();
  for (const [k, spec] of TABLE) {
    if (m.has(k)) throw new Error(`render-env: ${k} is classified twice`);
    m.set(k, spec);
  }
  return m;
}

/** Every KEY= (commented or not) in .env.example. */
export function envExampleKeys(text) {
  return [...new Set([...text.matchAll(/^#? ?([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]))];
}

/** Problems with the table against .env.example; [] when consistent. */
export function validate(envExampleText) {
  const problems = [];
  let map;
  try {
    map = tableMap();
  } catch (e) {
    return [String(e.message)];
  }
  const keys = envExampleKeys(envExampleText);
  for (const k of keys) if (!map.has(k)) problems.push(`${k} is in .env.example but not classified in scripts/deploy/render-env.mjs`);
  const inExample = new Set(keys);
  for (const [k, spec] of map) {
    const classes = ["value", "generate", "paste", "service", "exclude"];
    if (!classes.includes(spec.cls)) problems.push(`${k}: unknown class ${spec.cls}`);
    if (["value", "generate", "paste"].includes(spec.cls) && !(spec.group in GROUPS)) problems.push(`${k}: needs a group`);
    if (["service", "exclude"].includes(spec.cls) && spec.group) problems.push(`${k}: ${spec.cls} keys have no group`);
    if (spec.cls === "value" && typeof spec.value !== "string") problems.push(`${k}: value class needs a value`);
    if (spec.cls === "exclude" && !spec.why) problems.push(`${k}: say why it is excluded`);
    if (!inExample.has(k) && !spec.notInEnvExample) {
      problems.push(`${k} is classified but not in .env.example (add it there, or set notInEnvExample with the reason)`);
    }
  }
  return problems;
}

const yamlString = (v) => JSON.stringify(v); // a JSON string is a valid YAML double-quoted scalar

/** The `envVarGroups:` section of render.yaml. */
export function renderYamlGroups() {
  const map = tableMap();
  const lines = [
    "# BEGIN generated env groups — edit scripts/deploy/render-env.mjs, then run",
    "# `node scripts/deploy/render-env.mjs --write`. Secrets you paste are NOT listed",
    "# here (Render ignores sync: false inside env groups); they are in",
    "# docs/deploy/RENDER.md, \"Values you paste\". Render keeps a variable that a",
    "# Blueprint sync doesn't mention, so pasted values survive every sync.",
    "envVarGroups:",
  ];
  for (const [name, title] of Object.entries(GROUPS)) {
    lines.push(`  # ${title}.`);
    lines.push(`  - name: ${name}`);
    const entries = [...map].filter(([, s]) => s.group === name && (s.cls === "value" || s.cls === "generate"));
    const pasted = [...map].filter(([, s]) => s.group === name && s.cls === "paste").map(([k]) => k);
    if (pasted.length) {
      const launch = [...map].filter(([, s]) => s.group === name && s.cls === "paste" && s.need === "launch").length;
      lines.push(`    # Plus ${pasted.length} keys you paste in the dashboard (${launch} before the first deploy):`);
      lines.push(`    # docs/deploy/RENDER.md, "Values you paste".`);
    }
    lines.push("    envVars:");
    if (!entries.length) lines.push("      []");
    for (const [k, s] of entries) {
      lines.push(`      - key: ${k}`);
      if (s.cls === "generate") lines.push("        generateValue: true");
      else lines.push(`        value: ${yamlString(s.value)}`);
    }
  }
  lines.push("# END generated env groups");
  return lines.join("\n") + "\n";
}

/** The "Values you paste" block of docs/deploy/RENDER.md. */
export function renderDocBlock() {
  const map = tableMap();
  const out = [
    "<!-- BEGIN render-env (generated: node scripts/deploy/render-env.mjs --write) -->",
    "",
  ];
  for (const name of Object.keys(GROUPS)) {
    const pasted = [...map].filter(([, s]) => s.group === name && s.cls === "paste");
    if (!pasted.length) continue;
    const launch = pasted.filter(([, s]) => s.need === "launch");
    const later = pasted.filter(([, s]) => s.need !== "launch");
    out.push(`**${name}** (${GROUPS[name].toLowerCase()})`, "", "```dotenv");
    if (launch.length) {
      out.push("# Needed before the first deploy");
      for (const [k, s] of launch) out.push(...(s.why ? [`# ${s.why}`] : []), `${k}=`);
    }
    if (later.length) {
      if (launch.length) out.push("");
      out.push("# When you turn the feature on (leave out otherwise)");
      for (const [k, s] of later) out.push(...(s.why ? [`# ${s.why}`] : []), `${k}=`);
    }
    out.push("```", "");
  }
  const generated = [...map].filter(([, s]) => s.cls === "generate").map(([k, s]) => `\`${k}\` (${s.group})`);
  out.push(`Render generates these once, on the first Blueprint apply: ${generated.join(", ")}.`, "");
  const excluded = [...map].filter(([, s]) => s.cls === "exclude");
  const byWhy = new Map();
  for (const [k, s] of excluded) byWhy.set(s.why, [...(byWhy.get(s.why) ?? []), k]);
  out.push("<details><summary>Not set on Render, on purpose (" + excluded.length + " keys)</summary>", "");
  out.push("| Why | Keys |", "|---|---|");
  for (const [why, ks] of byWhy) out.push(`| ${why} | ${ks.map((k) => `\`${k}\``).join(", ")} |`);
  out.push("", "</details>", "", "<!-- END render-env -->");
  return out.join("\n");
}

const RENDER_YAML = join(ROOT, "render.yaml");
const RENDER_MD = join(ROOT, "docs", "deploy", "RENDER.md");

function spliceBetween(text, begin, end, replacement, file) {
  const a = text.indexOf(begin);
  const b = text.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`${file}: markers "${begin}" … "${end}" not found`);
  const endLineEnd = text.indexOf("\n", b);
  return text.slice(0, a) + replacement.trimEnd() + text.slice(endLineEnd < 0 ? text.length : endLineEnd);
}

export function expectedFiles(read = (f) => readFileSync(f, "utf8")) {
  const yaml = spliceBetween(read(RENDER_YAML), "# BEGIN generated env groups", "# END generated env groups", renderYamlGroups(), "render.yaml");
  const md = spliceBetween(read(RENDER_MD), "<!-- BEGIN render-env", "<!-- END render-env -->", renderDocBlock(), "docs/deploy/RENDER.md");
  return { [RENDER_YAML]: yaml, [RENDER_MD]: md };
}

/** Parse KEY=VALUE lines (.env syntax: optional quotes, # comments). */
export function parseDotenv(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^"/.test(v)) {
      const end = v.lastIndexOf('"');
      v = v.slice(1, end > 0 ? end : undefined).replace(/\\n/g, "\n");
    } else if (/^'/.test(v)) {
      const end = v.lastIndexOf("'");
      v = v.slice(1, end > 0 ? end : undefined);
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    if (v !== "") out.set(m[1], v);
  }
  return out;
}

/**
 * Put pasted values into their env groups through the Render API.
 * Returns the list of [key, group] written. Never logs values.
 */
export async function pushSecrets({ values, apiKey, dryRun = false, fetchImpl = fetch, base = "https://api.render.com/v1", log = console.log }) {
  const map = tableMap();
  const plan = [];
  const refused = [];
  for (const k of values.keys()) {
    const s = map.get(k);
    if (!s || s.cls !== "paste") refused.push(`${k} (${s ? `${s.cls}${s.group ? ` in ${s.group}` : ""}` : "unknown key"})`);
    else plan.push([k, s.group]);
  }
  if (refused.length) throw new Error(`refusing keys that are not owner-pasted: ${refused.join(", ")}`);
  if (dryRun) {
    for (const [k, g] of plan) log(`would set ${k} in ${g}`);
    return plan;
  }
  if (!apiKey) throw new Error("RENDER_API_KEY is not set");
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" };
  const groupIds = new Map();
  for (const g of new Set(plan.map(([, g]) => g))) {
    const res = await fetchImpl(`${base}/env-groups?name=${encodeURIComponent(g)}&limit=20`, { headers });
    if (!res.ok) throw new Error(`listing env group ${g}: HTTP ${res.status}`);
    const list = await res.json();
    const hit = (Array.isArray(list) ? list : []).map((x) => x.envGroup ?? x).find((x) => x?.name === g);
    if (!hit?.id) throw new Error(`env group ${g} not found — apply the Blueprint first`);
    groupIds.set(g, hit.id);
  }
  for (const [k, g] of plan) {
    const res = await fetchImpl(`${base}/env-groups/${groupIds.get(g)}/env-vars/${encodeURIComponent(k)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ value: values.get(k) }),
    });
    if (!res.ok) throw new Error(`setting ${k} in ${g}: HTTP ${res.status}`);
    log(`set ${k} in ${g}`);
  }
  return plan;
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === "push") {
    const fi = argv.indexOf("--file");
    if (fi < 0 || !argv[fi + 1]) throw new Error("usage: render-env.mjs push --file <path> [--dry-run]");
    const values = parseDotenv(readFileSync(argv[fi + 1], "utf8"));
    await pushSecrets({ values, apiKey: process.env.RENDER_API_KEY, dryRun: argv.includes("--dry-run") });
    return 0;
  }
  const problems = validate(readFileSync(join(ROOT, ".env.example"), "utf8"));
  if (problems.length) {
    console.error(`render-env: ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    return 1;
  }
  const files = expectedFiles();
  if (cmd === "--write") {
    for (const [f, text] of Object.entries(files)) writeFileSync(f, text);
    console.log("render-env: wrote render.yaml env groups and the docs/deploy/RENDER.md block");
    return 0;
  }
  if (cmd === "--check") {
    const stale = Object.entries(files).filter(([f, text]) => readFileSync(f, "utf8") !== text).map(([f]) => f.slice(ROOT.length + 1));
    if (stale.length) {
      console.error(`render-env: stale (run node scripts/deploy/render-env.mjs --write): ${stale.join(", ")}`);
      return 1;
    }
    console.log(`render-env: OK (${TABLE.length} keys classified)`);
    return 0;
  }
  console.error("usage: render-env.mjs --write | --check | push --file <path> [--dry-run]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`render-env: ${err.message}`);
      process.exit(1);
    },
  );
}
