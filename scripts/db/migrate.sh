#!/bin/sh
# ShapesOS — apply database migrations (used by the compose `migrate` service
# and CI). Repairs renamed-migration history first, then runs migrate deploy.
# Requires DATABASE_URL pointing at a role that owns the schema (the migrator),
# NOT the runtime app role.
set -eu
cd "$(dirname "$0")/../.."
npx prisma db execute --schema prisma/schema.prisma --file scripts/db/pre-migrate.sql
npx prisma migrate deploy
