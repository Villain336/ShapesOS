# Marketr — Playwright E2E (Phase A, fix 3)

End-to-end coverage of the M21 skills/connectors/settings surface plus chat
file attach. Everything runs **locally**: local PostgreSQL, `next start`
production preview, and in-repo mock fixtures. No live services, no real
credentials, no network egress.

## One-time setup

```bash
cd ~/workspace/marketr
npm install            # installs @playwright/test (devDependency)
npx playwright install chromium
```

## Run the whole thing

```bash
./scripts/e2e/run.sh
```

`run.sh` is the single entry point. It:

1. Sets an isolated E2E environment (`marketr_e2e` database, `e2e-admin@…` /
   `e2e-editor@…` accounts, throwaway `MARKETR_CREDENTIALS_KEY`).
2. Applies all Prisma migrations (`prisma migrate deploy`).
3. Builds the production bundle (`npm run build`).
4. Seeds via `npx tsx scripts/e2e/seed.mts`.
5. Starts `next start -p 3000` (background, killed on exit).
6. Runs `npx playwright test` headless.

### PostgreSQL

The runner does **not** start PostgreSQL for you — it expects one at
`$E2E_DATABASE_URL`, defaulting to:

```
postgresql://marketr:marketr@localhost:5432/marketr_e2e?schema=public
```

Point `E2E_DATABASE_URL` at any reachable PostgreSQL 15+ and make sure the
user owns the `public` schema (or grant it):

```sql
GRANT ALL ON SCHEMA public TO marketr;
ALTER SCHEMA public OWNER TO marketr;
```

## What the suite covers (17 spec tests + 1 auth setup, 5 files)

| File | Coverage |
|---|---|
| `tests/e2e/workspace-settings.spec.ts` | all 9 workspace settings pages render; Defaults save persists + `settings_workspace_updated` audit |
| `tests/e2e/project-settings.spec.ts` | all 6 project settings tabs render; General save persists + `settings_project_updated` audit |
| `tests/e2e/connectors.spec.ts` | API-key connect (encrypted vault storage, key never returned) + `connector_connected` audit; **mock OAuth round-trip** — auth URL → mock authorize → callback → token exchange, then listed + audited |
| `tests/e2e/skills.spec.ts` | URL install with SHA pinning (stale SHA → 409) + `skill_installed` audit; SKILL.md upload install |
| `tests/e2e/chat-attach.spec.ts` | chat file attach → staged chip → files API → `file_attached` audit |

Every navigation asserts **HTTP 200**, **zero page console errors**, and
**zero failed requests** (see `gotoClean` in `tests/e2e/helpers.ts`), and every
mutation asserts its **audit row** via the app's own `/api/settings/audit`
endpoint (`expectAudit`).

## The mock OAuth provider

`E2E_MOCK_OAUTH=1` (set by `run.sh`) registers a `mock-oauth` connector and
two fixture routes:

- `/api/e2e/mock-oauth/authorize` — immediate 302 consent redirect
- `/api/e2e/mock-oauth/token` — mints a fake access token

Both return **404** without the flag, and both validate the OAuth state
token exactly like a real provider. The round-trip exercises the production
`auth-url` and `callback` handlers, including credential encryption into the
vault.

## The skill fixture

`/api/e2e/skill-fixture/SKILL.md` serves a static `SKILL.md` (also 404 without
the flag; the `/SKILL.md` suffix is required by the importer's direct-URL
rule). The test previews it to obtain the server-computed SHA, then installs
with that SHA — the same SHA-pinning path a GitHub URL install takes. With
`E2E_MOCK_OAUTH=1` the importer pins direct `SKILL.md` URLs to the content
SHA-256 (production leaves non-GitHub URLs unpinned), so a stale SHA still
provokes the 409 mismatch branch.

## Manual steps (if you don't want run.sh)

```bash
export DATABASE_URL="postgresql://marketr:marketr@localhost:5432/marketr_e2e?schema=public"
export ADMIN_EMAIL=e2e-admin@example.com ADMIN_PASSWORD=e2e-admin-password
export E2E_ADMIN_EMAIL=$ADMIN_EMAIL E2E_ADMIN_PASSWORD=$ADMIN_PASSWORD
export NEXTAUTH_URL=http://localhost:3000 NEXTAUTH_SECRET=e2e-secret
export MARKETR_CREDENTIALS_KEY="$(openssl rand -hex 32)"
export E2E_MOCK_OAUTH=1
export E2E_MOCK_OAUTH_CLIENT_ID=e2e-mock-client
export E2E_MOCK_OAUTH_CLIENT_SECRET=e2e-mock-secret
export LLM_API_KEY=e2e-no-llm LLM_MODEL=e2e-no-model

npx prisma migrate deploy
npm run build
npx tsx scripts/e2e/seed.mts
npx next start -p 3000 &   # wait for /login to 200
npx playwright test
```

## Troubleshooting

- **Migrations: `permission denied for schema public`** — see the GRANT
  above; the DB user must own `public`.
- **Seed says "credentials provider not configured"** — `ADMIN_EMAIL` /
  `ADMIN_PASSWORD` must be set (run.sh derives them from `E2E_ADMIN_*`).
- **Mock OAuth card missing on the connectors page** — the server must be
  started with `E2E_MOCK_OAUTH=1` (and the production build must include the
  fixture routes — `next build` runs inside run.sh for this reason).
- **Console-error failures on first run** — `gotoClean` fails the test on any
  page console error or failed request. If a third-party font/CDN request
  fails in your sandbox, note it; do not blanket-suppress.
- **Port 3000 busy** — set `E2E_PORT` / `E2E_BASE_URL` (the config honors
  `E2E_BASE_URL` for both the app and the tests).
