# ShapesOS self-host quickstart (<10 minutes)

From zero to a running instance on a clean machine. Timed end-to-end at least
once before calling the F6 `quickstart` checklist item complete.

## Prerequisites (2 min)

- Node.js 22 (see `.nvmrc`)
- Docker (for Postgres), **or** any Postgres 16 you already run
- No API keys needed — everything provider-backed runs in mock mode until you
  add keys.

## Steps

```bash
# 1. Clone (30s)
git clone <repo-url> && cd ShapesOS

# 2. Install (2–3 min)
npm ci

# 3. Configure (1 min) — placeholders only; no real keys needed
cp .env.example .env
# Generate the auth secrets (don't skip on an internet-exposed box):
openssl rand -base64 32   # → NEXTAUTH_SECRET / AUTH_SECRET
openssl rand -base64 24   # → ADMIN_PASSWORD (min 20 chars)

# 4. Database (1–2 min). Skip the docker run if you already have Postgres 16.
docker run -d --name shapes-pg -e POSTGRES_USER=shapes -e POSTGRES_PASSWORD=shapes \
  -e POSTGRES_DB=shapes -p 127.0.0.1:5433:5432 postgres:16-alpine
# Migrate as the schema owner…
DATABASE_URL="postgresql://shapes:shapes@localhost:5433/shapes?schema=public" npm run db:migrate
# …then create the least-privilege role the app runs as. The app must not
# connect as the owner/superuser: superusers bypass row-level security.
docker exec -i shapes-pg psql -U shapes -d shapes -v ON_ERROR_STOP=1 \
  -v app_password=change_me_app < scripts/db/create-app-role.sql
# In .env (marketr_app keeps its historical name, like other internal ids):
#   DATABASE_URL="postgresql://marketr_app:change_me_app@localhost:5433/shapes?schema=public"

# 5. Run (30s)
npm run dev
# → http://localhost:3000 — sign in with ADMIN_EMAIL / ADMIN_PASSWORD
```

**Elapsed: ~7 minutes** on a typical machine (dominated by `npm ci`).

## What works with zero keys

- The full dashboard, keyword research UI, and content engine run against the
  **mock LLM provider** — the router degrades loudly (`[llm-router] … → mock`),
  never silently.
- SERP/competitor features that need DataForSEO show an honest "not configured"
  state with setup guidance instead of fake data.
- The launch-readiness tracker (`/dashboard/flywheel/launch`) works fully local.

## Production notes

- Put the app behind TLS (Caddy/Traefik/Cloudflare) before exposing it.
- Set `AUTH_TRUST_HOST=true` and a real `NEXTAUTH_URL`.
- Give Postgres a real password (`openssl rand -base64 32`) and persistent storage.
- Snapshot dir (`FIX_SNAPSHOT_DIR`) and report storage want durable volumes —
  see `DEPLOY.md`.
- For the hosted SaaS key model (KMS/vault instead of env keys), see
  `SECURITY.md` and `.env.example`'s secrets-provider section.
