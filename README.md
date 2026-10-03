# ShapesOS

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![CI](https://github.com/Villain336/ShapesOS/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![Self-host quickstart](https://img.shields.io/badge/self--host-%3C10_min-green)](./docs/quickstart.md)

> **Tagline:** the open-source agentic business OS: grow, design and operate a business from one workspace, with agents that propose and humans that approve.

- **Self-host it free** with your own provider keys, or run the hosted version with data bundled in.
- **Credential-light start:** [running in under 10 minutes with no API keys](./docs/quickstart.md). Provider-backed features degrade loudly to mock mode instead of faking data.
- **Agents with a leash:** every write that touches money, customers or the outside world goes through an approval. Autopilot never buys media or moves money.
- **Launch readiness (internal):** tracked in the app at `/dashboard/flywheel/launch`. Readiness only; there is no public launch until the open-core split is decided (see [docs/open-core-options.md](./docs/open-core-options.md)).

ShapesOS started life as Marketr, an SEO workspace. User-facing text now says ShapesOS everywhere. Internal identifiers keep the old name on purpose so existing installs keep working: `MARKETR_*` environment variables, `marketr_*` cookies, the `marketr_app` database role and the `marketr` compose volumes.

## Open vs. commercial

| | Open (AGPLv3) | Commercial |
|---|---|---|
| Core workspace (Grow / Design / Operate / Agents) | ✓ | ✓ |
| Self-hosting | ✓ | ✓ |
| White-label / agency resale | — (see note) | ✓ |
| Hosted SaaS with bundled data | — | ✓ |
| SLA & priority support | — | ✓ |

> **Note:** the exact open-vs-commercial boundary is **undecided**. Options A–D
> are staged neutrally in [docs/open-core-options.md](./docs/open-core-options.md)
> with no recommendation. The table above is the *shape* of the answer, not the
> answer. Commercial terms: [docs/commercial-license-terms.md](./docs/commercial-license-terms.md) (draft).

## Screenshots

> Staged — 3–5 real-UI screenshots (home + approvals inbox + CRM + Studio + launch tracker) to be captured from a current build before any public launch. No mockups or staged pixels.

## What's in it

The dashboard is organized the way the sidebar is (`lib/nav/config.ts`). Everything below has a page under `app/dashboard/` and code under `lib/`. Items marked *mock-only* or *partial* are honest about where they stop.

**Grow**
- **CRM**: leads, pipelines, capture forms, scoring, forecast, CSV import/export. *Partial:* you can't yet email, text, call, enroll in nurture or invoice straight from a lead.
- **Prospects** (enrichment, converts into leads), **Nurture** (email/SMS sequences with consent, quiet hours and speed-to-lead), **Reviews** (requests and AI-drafted replies behind approval).
- **SEO projects**: keyword research, competitor gaps, content engine with live SEO score, rank tracking with AI Overview presence, site audits with a fix agent (snapshots + one-click revert), site IDE, landing pages, WordPress/Webflow publishing, Vercel/Cloudflare deploys.
- **Intelligence**: market radar, AI-search visibility, competitor tracking, the Knowledge corpus.
- **Social** (publishing through a Postiz sidecar), **Authority** (outreach, digital PR, listings, answer-engine optimization), **Media** and ad platforms (Amazon Ads, StackAdapt, ChatGPT Ads; guided Walmart Connect and Spotify), **Direct mail**, **Calls** (tracking + booking pages), **Flywheel** (budget reallocation proposals, creative recycling, test lab), **Attribution**, **Reports**.
- **Analytics** is Umami pageviews only for now.

**Design**
- **Studio**: native canvas editor, AI design generation (draft-first), magic resize, batch fill, share/comment/approval links, branded PDF reports.
- **Clips** (long video into short clips, draft-for-approval), **Voice** (voice agents, scripts and voiceovers; local VoiceStudio TTS by default), **CAD** (in-browser viewer and versioning, AI design assistant, prototype export, hardware projects; a derived BOM is still to come).

**Operate**
- **Office** (docs, sheets and decks), **Files**, **E-sign** (Documenso adapter, hash-chained audit), **Legal** (obligation map, deadline engine, document vault, change radar), **Insurance** (policy inventory, quoting, gated bind, renewals, COIs).
- **Funding** (investor CRM, data room with expiring links and per-viewer analytics, round readiness) and **Network** (the connector agent: relationship graph, intro paths, double-opt-in intros for leads and investors).
- **Datasets** (ingest, classify and compile versioned business datasets with lineage), **WFH mode**, **Alerts**.
- Ops entities behind the agents: invoicing, inventory, projects/HR, with approval gates on anything that sends or spends.

**Agents**
- **Approvals**: one "needs you" inbox across the approval queues, with a sidebar badge and a notification center.
- **Runs** (index and replays), **Assistant** (chat), **Missions** and **Playbooks** (goal → multi-agent plan), **Actions** (Composio app actions; reads run, writes need approval), **Substrate** (business graph and growth memory).
- **MCP server** (`app/mcp`, OAuth 2.1 + PKCE, scoped API keys) so outside agents can drive ShapesOS.

**Platform**
- Workspaces with owner/admin/editor/viewer roles, invites by email, agency client workspaces, white-label.
- SSO (OIDC; SAML via BoxyHQ), metering + Stripe billing with credit pools and spend caps, a hosted trial mode.
- Postgres row-level security on tenant tables, enforced by running the app as a non-superuser role.
- Expo mobile app in `mobile/` (agent chat + approvals; still carries the old bundle ids and has no push yet).

**Known gaps** (see [docs/audit/FULL-AUDIT-2026-10-03.md](./docs/audit/FULL-AUDIT-2026-10-03.md) §7 and [docs/audit/REMEDIATION-PLAN.md](./docs/audit/REMEDIATION-PLAN.md)):
- GA4, Search Console, Google Ads, Meta Ads, Google Drive and Notion connectors are **mock-only**, as are outreach sending and Google Business Profile (`lib/connectors/m21/native/*`, `lib/local/gbp.ts`). This is missing code, not missing keys.
- No GDPR export, 2FA/passkeys, SCIM, OpenAPI spec, outbound webhooks or `/api/health` yet.

## Quickstart (local dev)

Requirements: Node 22 (see `.nvmrc`) and a Postgres 16 you can reach. For the full Docker stack instead, see [DEPLOY.md](./DEPLOY.md) and [docs/quickstart.md](./docs/quickstart.md).

```bash
npm ci
cp .env.example .env
```

The app must **not** connect as the schema owner or a superuser: superusers bypass `FORCE ROW LEVEL SECURITY`, which silently turns off tenant isolation. So there are two database roles:

```bash
# 1. Migrate as the role that owns the schema (the migrator).
#    Setting APP_DB_PASSWORD also creates/refreshes the least-privilege app
#    role (APP_DB_USER, default marketr_app) via scripts/db/create-app-role.sql
#    (this step needs psql on your PATH).
DATABASE_URL="postgresql://<owner>:<pw>@localhost:5432/<db>?schema=public" \
APP_DB_PASSWORD="$(openssl rand -hex 32)" \
npm run db:migrate

#    Or create the app role yourself (re-run after new migrations):
#    psql "postgresql://<owner>:<pw>@localhost:5432/<db>" \
#      -v app_password='…' -f scripts/db/create-app-role.sql

# 2. Point DATABASE_URL in .env at the app role, then run.
npm run dev
```

Open http://localhost:3000 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. `npm run db:seed` loads a demo workspace.

## Testing

```bash
npm test                 # unit suites (node:test via tsx; DATABASE_URL is unset on purpose)
npm run test:db          # DB-backed suites listed in scripts/test/db-tests.txt; needs a migrated
                         # DATABASE_URL, ideally as the non-superuser app role (that's what CI does)
NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck   # next typegen + tsc; needs the bigger heap
npx tsx scripts/verify-phase7-launch.mts                   # launch-readiness battery
node scripts/verify-m11-security.mjs                       # security battery
```

`mobile/` has its own package and vitest suite. CI (`.github/workflows/ci.yml`) runs install, Prisma validate, typecheck, a secret scan, unit tests, migrations on a fresh database, a schema-drift guard, DB tests as the app role, both batteries, a credential-free smoke test and a production build.

## Deployment

[DEPLOY.md](./DEPLOY.md) is the runbook: compose services (a one-shot `migrate` service creates the app role; the app connects as it), required secrets, loopback-only ports, sidecars (Postiz, Listmonk, Umami, Activepieces), cron endpoints and rollback. Scheduled work runs through authenticated `POST /api/cron/*` endpoints you call with `Authorization: Bearer $CRON_SECRET`.

## Key environment switches

All documented in [.env.example](./.env.example).

| Variable | Default | What it does |
|---|---|---|
| `DEPLOYMENT_MODE` | `self_hosted` | `self_hosted`: bring your own keys, usage recorded but never blocked. `hosted`: a person's first workspace gets a 14-day, 500-credit trial behind a hard cap, then needs a plan. |
| `SIGNUP_MODE` | `open` | `open`: any SSO sign-in without a workspace gets one. `invite`: new users need a pending invite. |
| `TRUSTED_PROXY_HOPS` | `1` | How many reverse proxies append to `X-Forwarded-For`. Used for login lockouts and rate limits; `0` trusts no proxy header. |
| `MARKETR_PLATFORM_OPERATORS` | unset (nobody) | User ids or emails allowed to change host-wide resources (shared Knowledge corpus, Activepieces flow bindings). |
| `ALLOW_FAKE_PROVIDERS` | `0` | Fake SMS/email/call/mail providers are the dev default but refused in production unless set to `1` for a demo install. |

With `NODE_ENV=production`, features whose signing or encryption secret is unset refuse to run rather than fall back to a built-in value.

## Docs

- [docs/COMPLETE-VISION.md](./docs/COMPLETE-VISION.md): every module and its real status.
- [docs/design/DESIGN.md](./docs/design/DESIGN.md): the Agentic OS design system all UI follows.
- [docs/specs/](./docs/specs/): the original product spec and phase specs. [docs/phases/](./docs/phases/): later phase specs.
- [docs/security/](./docs/security/): threat models. [docs/history/](./docs/history/): past audits, reports and design maps.
- [CONTRIBUTING.md](./CONTRIBUTING.md), [SECURITY.md](./SECURITY.md), [CHANGELOG.md](./CHANGELOG.md), [THIRD_PARTY.md](./THIRD_PARTY.md).

## License

ShapesOS core is licensed under the **GNU Affero General Public License v3.0**; see [LICENSE](./LICENSE). If you run a modified version on a public server, you must make the modified source available to its users (AGPL §13). A separate commercial license covers the white-label module for agencies.
