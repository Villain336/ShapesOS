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
- **Backups:** nightly `pg_dump` to object storage + the `marketr-data` volume snapshotted.

### 1a. Gap to fix before deploy (small code change, spec'd here)

`docker-compose.yml` currently has **no volume for `.data/`** — site working copies (M7),
fix-agent snapshots (M10), report PDFs + brand-kit logos (M12), and programmatic-SEO
sitemaps (M17, `.data/sitemaps`, unless `SITEMAP_STORAGE_DIR` points elsewhere) live on the
container's writable layer. They survive restarts but are lost on `compose down` / rebuild. Before deploy:

1. Add a named volume: `marketr-data:/app/.data` on the `app` service.
2. Set `SITE_STORAGE_DIR=/app/.data/sites`, `FIX_SNAPSHOT_DIR=/app/.data/fix-snapshots`,
   `REPORT_STORAGE_DIR=/app/.data/reports`, and `SITEMAP_STORAGE_DIR=/app/.data/sitemaps` in `.env`.
3. Rebuild and confirm a site working copy survives `docker compose down && docker compose up -d`.

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

Secrets (4–7) go in `.env` on the VPS only — never in git, never in chat. When ready, Tico hands
them over via the Secure Vault flow and Z7 writes them server-side.

## 3. Runbook

1. **Provision:** fresh Ubuntu 24.04, create deploy user, install Docker + Caddy.
2. **DNS:** A record `marketr.launchabl.com` → VPS IP. Confirm propagation.
3. **Code:** `git clone` the vault repo to `/opt/marketr` (local-only remote — this stays private;
   no GitHub remote is created).
4. **Env:** copy `.env.example` → `.env`, fill §2 items 3–7. `chmod 600 .env`.
5. **Data volume fix:** apply §1a, then `docker compose up -d --build`.
6. **Migrations:** watch boot logs — `npx prisma migrate deploy` must apply all 15 migrations cleanly
   (`..._init` → `..._content_autopilot`). The M15 (`..._backlinks_internal_links`), M16
   (`..._local_seo`), M17 (`..._programmatic_seo`), and M18 (`..._content_autopilot`)
   migrations are hand-written (no PostgreSQL in the sandbox build environment) — review
   them carefully before deploy.
   Verify with `docker compose exec db psql -U marketr -c "\dt"`.
7. **Caddy:** reverse-proxy `marketr.launchabl.com` → `localhost:3000`, auto-TLS. Confirm HTTPS.
8. **Cron (host crontab):**
   - `0 6 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/rankings/check -d '{"scope":"all"}'`
   - `30 6 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/fix-agent`
   - `0 7 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/reports`
   - `*/15 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/alerts`
   - `0 8 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/visibility-score` (milestone 14: daily composite score + visibility_delta alerts)
   - `0 9 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/decay` (milestone 14: weekly content-decay detection)
   - `30 9 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/radar` (milestone 14: weekly competitor radar)
   - `0 10 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/backlinks` (milestone 15: weekly backlink refresh; per-project backlinksEnabled toggle; cost caps enforced server-side)
   - `30 10 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/internal-links` (milestone 15: weekly internal-link suggestions)
   - `0 11 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/local-grid` (milestone 16: weekly geo-grid runs; enabled weekly grids due since last run; cost caps enforced server-side)
   - `30 11 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/local-competitors` (milestone 16: weekly local-competitor snapshot refresh; enabled competitors only)
   - `0 12 * * 1 curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/reviews` (milestone 16: weekly review ingest + sentiment summaries + negative-review alerts)
   - `0 7 * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://marketr.launchabl.com/api/cron/autopilot` (milestone 18: daily sweep; runs only daily/weekly rules whose cadence is due; kill switch, per-run item cap, idempotency, and the approval gate are enforced server-side)
9. **Smoke test:** log in, create workspace + project, confirm pages load, no console errors.
10. **Backups:** nightly `pg_dump` cron → object storage; document restore command.

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
- [ ] **Cron:** trigger both cron endpoints manually with `CRON_SECRET`, confirm 200s and expected side effects.

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
