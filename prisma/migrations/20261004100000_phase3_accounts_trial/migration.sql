-- Phase 3 (workstream I): accounts, trial plan, onboarding, workspace lifecycle.

-- 1. Hosted trial plan (DEPLOYMENT_MODE=hosted signups; lib/billing/trial.ts).
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'trial' AFTER 'self_hosted';

-- 2. Workspace-scoped audit actions for lifecycle + agency client records.
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'workspace_created';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'workspace_renamed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'client_created';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'client_updated';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'client_deleted';

-- 3. Trial end + onboarding state on the workspace.
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "trial_ends_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "onboarding_step" TEXT,
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" TIMESTAMP(3);

-- Workspaces that already exist are not brand-new: never show them the
-- first-run wizard.
UPDATE "workspaces"
   SET "onboarding_completed_at" = CURRENT_TIMESTAMP
 WHERE "onboarding_completed_at" IS NULL;

-- 4. Lifecycle audit trail. No FK to workspaces on purpose: the record of a
-- deletion must survive the deletion's cascade.
CREATE TABLE IF NOT EXISTS "workspace_lifecycle_events" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "workspace_name" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_lifecycle_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "workspace_lifecycle_events_workspace_id_created_at_idx"
  ON "workspace_lifecycle_events"("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "workspace_lifecycle_events_actor_user_id_action_idx"
  ON "workspace_lifecycle_events"("actor_user_id", "action");

-- 5. usage_events stays append-only (THREAT-MODEL-METERING.md T5), but the
-- trigger made workspace deletion impossible: the ON DELETE CASCADE from
-- workspaces (and the ON DELETE SET NULL from projects) were refused like any
-- other mutation. Allow exactly those two foreign-key effects:
--   * DELETE of a row whose workspace no longer exists (the cascade runs
--     after the workspace row is gone, so a live workspace's ledger stays
--     untouchable);
--   * an UPDATE that only clears project_id after that project was deleted.
CREATE OR REPLACE FUNCTION prevent_usage_event_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = OLD."workspace_id") THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."project_id" IS NOT NULL AND NEW."project_id" IS NULL
     AND (to_jsonb(NEW) - 'project_id') = (to_jsonb(OLD) - 'project_id')
     AND NOT EXISTS (SELECT 1 FROM "projects" WHERE "id" = OLD."project_id") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'usage_events is append-only: % not allowed (see THREAT-MODEL-METERING.md T5)', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
