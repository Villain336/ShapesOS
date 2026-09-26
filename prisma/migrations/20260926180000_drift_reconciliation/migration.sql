-- Marketr drift reconciliation (2026-09-26).
-- Reconciles pre-existing schema <-> DB drift found by Phase 10 M7c
-- verification (not caused by Phase 10). Tico-approved fix.
-- NO DATA LOSS: only additive changes. Nothing is dropped, altered in a
-- destructive way, or backfilled.

-- 1. FileChangeAction enum: three values declared in schema.prisma were
-- missing from the DB enum. ADD VALUE IF NOT EXISTS is idempotent.
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'graph_connector_changed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'graph_fact_appended';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'graph_merge_decided';

-- 2. Adopt billing_topup_idempotency. This table was created lazily at
-- runtime by lib/metering/billing.ts (ensureIdempotencyTable) and therefore
-- existed in the DB with no Prisma model. The schema now declares it, so
-- this migration adopts the existing table. IF NOT EXISTS makes the
-- statement a no-op where the table already exists (preview DB).
CREATE TABLE IF NOT EXISTS "billing_topup_idempotency" (
  "idempotency_key"   TEXT PRIMARY KEY,
  "workspace_id"      TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "credits"           INTEGER NOT NULL,
  "amount_cents"      INTEGER NOT NULL,
  "stripe_session_id" TEXT NOT NULL,
  "source"            TEXT NOT NULL,
  "applied_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. search_tsv: no DDL here. The GENERATED ALWAYS tsvector columns on
-- memory_episodes / memory_facts / memory_learnings were created by
-- migration 20260925180000_phase8_memory and are now declared as
-- Unsupported("tsvector") in schema.prisma, so Prisma Migrate leaves them
-- alone (a migrate-from-schema diff no longer proposes dropping them).
