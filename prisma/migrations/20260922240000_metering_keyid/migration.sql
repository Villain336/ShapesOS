-- Phase C gaps (G1): per-key usage attribution + explicit auto-overage flag
-- + scheduler "blocked" run status for the pre-run cap gate.
-- HAND-WRITTEN — verify against local PostgreSQL before commit.
-- All statements idempotent: safe to re-run.

-- 1. Per-key attribution: which MCP API key / OAuth client a charge belongs to.
--    NULL for non-MCP charges (UI, cron, scheduler). Validated server-side in
--    meter(): the key must belong to the charged workspace (T8).
DO $$ BEGIN
  ALTER TABLE "usage_events" ADD COLUMN "key_id" TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "usage_events_workspace_id_key_id_idx"
  ON "usage_events"("workspace_id", "key_id");

-- 2. Explicit auto-overage opt-in. Default false: the hard cap stays the
--    default; the billing track flips this when the customer opts into
--    automatic overage (Stripe flow). Effective overage =
--    auto_overage OR NOT block_at_cap (legacy opt-out preserved).
DO $$ BEGIN
  ALTER TABLE "spend_caps" ADD COLUMN "auto_overage" BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 3. Scheduler pre-run cap gate needs a terminal "blocked" status so a run
--    that never executed is distinguishable from cancelled/failed (T9).
DO $$ BEGIN
  ALTER TYPE "SkillRunStatus" ADD VALUE 'blocked';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
