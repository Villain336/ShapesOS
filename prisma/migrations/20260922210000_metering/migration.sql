-- Phase C (W4): hosted metering ledger (spec §7 W4).
-- HAND-WRITTEN — verified against local PostgreSQL 16 before commit.
-- All statements idempotent: safe to re-run.

-- Immutable usage ledger (idempotent)
CREATE TABLE IF NOT EXISTS "usage_events" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "project_id" TEXT,
  "actor_id" TEXT,
  "action" TEXT NOT NULL,
  "credits" INTEGER NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotency_key" TEXT NOT NULL,
  "evidence_ref" TEXT,
  CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "usage_events_idempotency_key_key" ON "usage_events"("idempotency_key");
CREATE INDEX IF NOT EXISTS "usage_events_workspace_id_occurred_at_idx" ON "usage_events"("workspace_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "usage_events_workspace_id_action_idx" ON "usage_events"("workspace_id", "action");
CREATE INDEX IF NOT EXISTS "usage_events_project_id_idx" ON "usage_events"("project_id");
DO $$ BEGIN
  ALTER TABLE "usage_events"
    ADD CONSTRAINT "usage_events_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "usage_events"
    ADD CONSTRAINT "usage_events_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- T5: the ledger is append-only. This trigger rejects UPDATE and DELETE on
-- usage_events at the database level, so even direct SQL/console access
-- cannot rewrite history. Application code only ever INSERTs.
CREATE OR REPLACE FUNCTION prevent_usage_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'usage_events is append-only: % not allowed (see THREAT-MODEL-METERING.md T5)', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS usage_events_no_mutation ON "usage_events";
CREATE TRIGGER usage_events_no_mutation
  BEFORE UPDATE OR DELETE ON "usage_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_usage_event_mutation();

-- Per-workspace credit pool for the current billing period (idempotent).
-- Mutated only inside meter()'s locked transaction — see T2/T6.
CREATE TABLE IF NOT EXISTS "credit_balances" (
  "workspace_id" TEXT NOT NULL,
  "included_credits" INTEGER NOT NULL,
  "purchased_credits" INTEGER NOT NULL DEFAULT 0,
  "purchased_expires_at" TIMESTAMP(3),
  "used_credits" INTEGER NOT NULL DEFAULT 0,
  "period_start" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credit_balances_pkey" PRIMARY KEY ("workspace_id")
);
DO $$ BEGIN
  ALTER TABLE "credit_balances"
    ADD CONSTRAINT "credit_balances_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Spend guard (idempotent). Default: hard cap ON at 100% of pool, alert at 80%.
CREATE TABLE IF NOT EXISTS "spend_caps" (
  "workspace_id" TEXT NOT NULL,
  "cap_credits" INTEGER NOT NULL,
  "block_at_cap" BOOLEAN NOT NULL DEFAULT true,
  "alert_at_pct" INTEGER NOT NULL DEFAULT 80,
  "last_alert_at" TIMESTAMP(3),
  CONSTRAINT "spend_caps_pkey" PRIMARY KEY ("workspace_id")
);
DO $$ BEGIN
  ALTER TABLE "spend_caps"
    ADD CONSTRAINT "spend_caps_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Audit actions for metering outcomes (idempotent)
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_metering_blocked';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_metering_failed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'spend_cap_updated';
