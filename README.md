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

- `app/` — Next.js App Router UI (foundation page only in milestone 1)
- `prisma/schema.prisma` — data model: Workspace, Project, Keyword, Ranking, Competitor, ContentItem, Client, Report, ApiUsage, Issue, FixRun
- `docker-compose.yml` — app + Postgres 16 + Redis 7
- `Dockerfile` — production standalone image
- `SPEC.md` — the full product spec (source of truth)

## Data & costs

Self-hosted Marketr is bring-your-own-keys: a [DataForSEO](https://dataforseo.com) account (pay-as-you-go) for keyword/SERP data and an LLM provider key for the content engine and fix agent. No scraping, no bundled data markup — see SPEC.md §9 for the hosted unit economics.

## License

Marketr core is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](./LICENSE). If you run a modified version on a public server, you must make the modified source available to its users (AGPL §13). A separate commercial license covers the white-label module for agencies.
