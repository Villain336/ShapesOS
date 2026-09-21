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

## Data & costs

Self-hosted Marketr is bring-your-own-keys: a [DataForSEO](https://dataforseo.com) account (pay-as-you-go) for keyword/SERP data and an LLM provider key for the content engine and fix agent. No scraping, no bundled data markup — see SPEC.md §9 for the hosted unit economics.

## License

Marketr core is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](./LICENSE). If you run a modified version on a public server, you must make the modified source available to its users (AGPL §13). A separate commercial license covers the white-label module for agencies.
