# Marketr

Marketr is the open-source marketing & SEO workspace/OS: keyword research, competitor gap analysis, an AI content engine, rank tracking (including AI Overview presence), site audits with an auto-fix agent, and white-label client reporting for agencies — in one self-serve workspace. Self-host it free with your own API keys, or run the hosted version with data bundled in.

Full product spec: [SPEC.md](./SPEC.md)

## Self-host quickstart

Requirements: Docker + Docker Compose.

```bash
cp .env.example .env
# Edit .env — at minimum set DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD,
# and one LLM key (ANTHROPIC_API_KEY or OPENAI_API_KEY).
docker compose up -d
```

Open http://localhost:3000. Prisma migrations run automatically on container start.

### Local dev (without Docker)

```bash
npm install
cp .env.example .env   # point DATABASE_URL / REDIS_URL at local services
npx prisma migrate dev
npm run dev
```

## Project layout

- `app/` — Next.js App Router UI: `/` landing, `/login`, `/dashboard` (projects CRUD), `/dashboard/projects/[id]/keywords` (keyword research)
- `app/api/` — route handlers: auth, projects, keyword ideas/save/saved
- `lib/providers/` — swappable SEO data-provider interface: DataForSEO (live when `DATAFORSEO_*` set) or clearly-marked mock fallback
- `prisma/schema.prisma` — data model: Workspace, Project, Keyword, Ranking, Competitor, ContentItem, Client, Report, ApiUsage, Issue, FixRun
- `prisma/migrations/` — SQL migrations (applied via `migrate deploy` on container start)
- `prisma/seed.ts` — demo workspace/project/keywords (`npm run db:seed`)
- `auth.ts` — Auth.js v5: Google OAuth + self-hosted admin credentials (`ADMIN_EMAIL`/`ADMIN_PASSWORD`)
- `docker-compose.yml` — app + Postgres 16 + Redis 7
- `Dockerfile` — production standalone image
- `SPEC.md` — the full product spec (source of truth)

## Milestones

- **M1 (done):** scaffold, data model, Docker, license, README.
- **M2 (done):** DB wiring + first migration + seed, Auth.js (Google + admin credentials), workspace/project CRUD, DataForSEO provider abstraction, keyword-research flow (seed → ideas with volume/difficulty/CPC/intent → filter → save to list).
- **M3 (done):** competitor keyword-gap analysis — competitor domains per project, gap diff vs. saved keywords with opportunity scoring, one-click save.
- **M4 (done):** content engine — SERP-informed brief → AI draft (swappable LLM provider) → editor with live, explainable SEO score; brief → draft → editing → published lifecycle.
- **M5 (done):** rank tracking — tracked-keyword toggle, on-demand + scheduled rank checks, positions table with deltas, unified visibility score, AI Overview presence, movement alerts.
- **M6 (done):** site IDE — SFTP site connections (AES-256-GCM encrypted at rest, never exposed to the client), file browser + Monaco code editor, AI assistant that proposes diffs the user must approve (supervised rung), append-only change audit log, demo mock site for credential-free tryout.
- **M7 (done):** landing pages & websites — SiteConnector abstraction (GitHub + labeled mock + zip/file upload), Site model, AI landing-page builder with sandboxed preview, deploy to GitHub/SFTP/zip download, IDE wired to Sites.
- **M8 (done):** WordPress + Webflow connectors — WP REST via app passwords (pages/posts/media CRUD), Webflow API v2 (CMS collections/items CRUD + site publish), labeled mocks, ContentBrowser UI, publish-to flow from landing pages.
- **M9 (done):** hosting — DeployTarget abstraction, Vercel + Cloudflare Pages connectors (encrypted tokens, labeled mocks), HostingConnection + Deployment models, deploy-to-hosting flow with live URL + audit log.
- **M10 (done):** fix-agent scheduled rung — site audits (broken links, missing title/meta/OG/alt, mixed content, oversized images, robots/sitemap, style bloat), issue inbox with per-issue approval, per-site safety settings (enabled, allowed categories, max fixes/run, dry-run default ON), scheduled execution via cron with pre-change snapshots + one-click revert, full audit logging.
- **M11 (done):** enterprise security — generic OIDC SSO + SAML via BoxyHQ (both env-configured, buttons appear on /login only when set), domain-based SSO auto-provisioning, workspace RBAC (owner/admin/editor/viewer with API-level enforcement and a Members settings page), secrets-provider abstraction (`lib/secrets` — env AES-256-GCM default, documented AWS-KMS stub), security headers, 12h absolute session lifetime, workspace-scoped audit events for credential lifecycle + membership changes.

### Scheduled rank checks

Self-hosted Next.js has no built-in cron, so rank checks run through an
authenticated endpoint you call on a schedule:

1. Set a long random `CRON_SECRET` in `.env` (`openssl rand -hex 32`).
2. Add a cron line (daily at 6am here; pick your own cadence):

```cron
0 6 * * * curl -s -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"all"}' \
  https://your-marketr-host/api/rankings/check
```

- `{"projectId":"<id>"}` checks one project; `{"projectId":"all"}` checks
  every project (cron secret only — a signed-in session can't use `"all"`).
- Each check runs one SERP call per tracked keyword and writes `Ranking`
  rows, so schedule with your DataForSEO budget in mind.

### Scheduled fix-agent runs

The fix agent's scheduled rung (M10) uses the same cron-secret pattern.
Per-site settings live on the Sites page: enable the agent, choose which
issue categories it may fix without asking, cap fixes per run, and keep
dry-run mode on until you trust it (dry runs only store diff previews).

```cron
0 7 * * * curl -s -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://your-marketr-host/api/cron/fix-agent
```

The endpoint runs every site with the agent enabled, applies eligible fixes
(explicitly approved issues, or allow-listed non-destructive categories),
snapshots every touched file before writing (`.data/fix-snapshots/`, or
`FIX_SNAPSHOT_DIR`), audit-logs each change as actor `fix_agent`, and
re-scans to verify. A signed-in session can hit the same endpoint to run all
of *your* projects on demand. Revert any run from the Sites → Fix agent panel.

## Data & costs

Self-hosted Marketr is bring-your-own-keys: a [DataForSEO](https://dataforseo.com) account (pay-as-you-go) for keyword/SERP data and an LLM provider key for the content engine and fix agent. No scraping, no bundled data markup — see SPEC.md §9 for the hosted unit economics.

## Enterprise security (M11)

**SSO.** Set `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` for any
OIDC-compliant IdP (Okta, Entra ID, Google Workspace, Keycloak, Authentik) —
a "Continue with SSO" button appears on `/login` only when configured.
SAML works through a BoxyHQ SAML Jackson bridge: `SAML_ENABLED=true` plus
`BOXYHQ_SAML_ISSUER` (your Jackson URL), `BOXYHQ_SAML_CLIENT_ID`,
`BOXYHQ_SAML_CLIENT_SECRET`. Optional domain-based auto-provisioning:
`SSO_DOMAIN` + `SSO_WORKSPACE_ID` + `SSO_DEFAULT_ROLE` add matching SSO
users to that workspace on first sign-in. SSO paths are config-complete but
were not live-verified (no IdP in the build environment).

**RBAC.** Workspace roles: `owner` > `admin` > `editor` > `viewer`.
Viewers are read-only; editors write but can't manage members or stored
credentials; admins can't delete the workspace; owners have full control.
Enforced at the API layer (`lib/authz.ts` — `requireProjectRole` /
`requireWorkspaceRole`, 403 on denial). Manage members at
`/dashboard/settings/members` (admin+): invite by email (pending until first
sign-in), change roles, remove. The last owner is protected. Membership and
credential changes are audit-logged.

**Secrets.** All credential encryption flows through `lib/secrets`
(`SecretsProvider` interface). Default `SECRETS_PROVIDER=env` uses the
existing AES-256-GCM `MARKETR_CREDENTIALS_KEY` scheme. For hosted production,
implement the documented `AwsKmsSecretsProvider` stub against
`@aws-sdk/client-kms` (per-workspace data keys, rotation) and set
`SECRETS_PROVIDER=aws-kms`.

**Hardening.** Security headers in `next.config.ts` (nosniff, SAMEORIGIN
framing, strict referrer policy, locked-down permissions policy, HSTS on
https). Sessions are JWT with an absolute 12h lifetime. CSP is intentionally
deferred: Monaco loads editor assets from a CDN and needs `unsafe-eval` for
workers, so a CSP today would be theater — self-host the editor assets first.

## License

Marketr core is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](./LICENSE). If you run a modified version on a public server, you must make the modified source available to its users (AGPL §13). A separate commercial license covers the white-label module for agencies.
