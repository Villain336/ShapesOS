#!/bin/sh
# ShapesOS — apply database migrations (used by the compose `migrate` service
# and CI). Repairs renamed-migration history first, then runs migrate deploy.
# Requires DATABASE_URL pointing at a role that owns the schema (the migrator),
# NOT the runtime app role.
#
# When APP_DB_PASSWORD is set (compose), it then creates/refreshes the
# least-privilege runtime role APP_DB_USER (default marketr_app) via
# scripts/db/create-app-role.sql — idempotent, and re-run after every
# migration so grants cover new tables.
set -eu
cd "$(dirname "$0")/../.."
npx prisma db execute --schema prisma/schema.prisma --file scripts/db/pre-migrate.sql
npx prisma migrate deploy
if [ -n "${APP_DB_PASSWORD:-}" ]; then
  # libpq rejects Prisma's ?schema= query parameter.
  psql "${DATABASE_URL%%\?*}" -v ON_ERROR_STOP=1 -q \
    -v app_role="${APP_DB_USER:-marketr_app}" -v app_password="$APP_DB_PASSWORD" \
    -f scripts/db/create-app-role.sql
fi
