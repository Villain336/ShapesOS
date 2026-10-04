#!/usr/bin/env bash
# Marketr — Playwright E2E runner (Phase A, fix 3).
# Boots a fully local preview (PostgreSQL + `next start`) and runs the suite.
#
# Usage:  ./scripts/e2e/run.sh
# Prereqs: PostgreSQL reachable at $E2E_DATABASE_URL (default below),
#          node_modules installed, `npx playwright install chromium` done once.
#
# The app is started with E2E_MOCK_OAUTH=1, which registers the test-only
# mock OAuth provider and fixture routes. NEVER set that flag in production.
#
# CI (.github/workflows/ci.yml, job e2e) runs this same script with:
#   E2E_DATABASE_URL      the schema owner (migrations + seed)
#   E2E_APP_DATABASE_URL  the least-privilege app role the server runs as
#                         (create it first: scripts/db/create-app-role.sql).
#                         Unset = the server uses E2E_DATABASE_URL (local runs).
#   E2E_SKIP_BUILD=1      reuse an existing .next build.

set -euo pipefail
cd "$(dirname "$0")/../.."

export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:3000}"
export E2E_PORT="${E2E_PORT:-3000}"
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql://marketr:marketr@localhost:5432/marketr_e2e?schema=public}"
APP_DATABASE_URL="${E2E_APP_DATABASE_URL:-$DATABASE_URL}"
export E2E_ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-e2e-admin@example.com}"
export E2E_ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-e2e-admin-password}"
export E2E_EDITOR_EMAIL="${E2E_EDITOR_EMAIL:-e2e-editor@example.com}"
export ADMIN_EMAIL="$E2E_ADMIN_EMAIL"
export ADMIN_PASSWORD="$E2E_ADMIN_PASSWORD"
export NEXTAUTH_URL="$E2E_BASE_URL"
export NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-e2e-nextauth-secret-please-change}"
export MARKETR_CREDENTIALS_KEY="${MARKETR_CREDENTIALS_KEY:-$(openssl rand -hex 32)}"
export E2E_MOCK_OAUTH=1
export E2E_MOCK_OAUTH_CLIENT_ID="${E2E_MOCK_OAUTH_CLIENT_ID:-e2e-mock-client}"
export E2E_MOCK_OAUTH_CLIENT_SECRET="${E2E_MOCK_OAUTH_CLIENT_SECRET:-e2e-mock-secret}"
export LLM_API_KEY="${LLM_API_KEY:-e2e-no-llm}"
export LLM_MODEL="${LLM_MODEL:-e2e-no-model}"

echo "==> [e2e] migrate (scripts/db/migrate.sh)"
sh scripts/db/migrate.sh

if [ "${E2E_SKIP_BUILD:-}" = "1" ]; then
  echo "==> [e2e] E2E_SKIP_BUILD=1 — reusing the existing .next build"
else
  echo "==> [e2e] building production bundle (next build)"
  npm run build
fi

echo "==> [e2e] seeding"
npx tsx scripts/e2e/seed.mts

echo "==> [e2e] starting next start -p $E2E_PORT"
DATABASE_URL="$APP_DATABASE_URL" npx next start -p "$E2E_PORT" > /tmp/marketr-e2e-server.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

echo "==> [e2e] waiting for $E2E_BASE_URL"
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "$E2E_BASE_URL/login"; then
    echo "    up after ${i}s"
    break
  fi
  if [ "$i" = "60" ]; then
    echo "    server did not come up; log tail:"
    tail -40 /tmp/marketr-e2e-server.log
    exit 1
  fi
  sleep 1
done

echo "==> [e2e] running playwright"
npx playwright test
