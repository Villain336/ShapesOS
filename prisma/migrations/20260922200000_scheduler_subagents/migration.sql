-- Phase B (W2, track B2): scheduled skills + parallel subagent runs.
-- Handwritten, idempotent (M21 convention): safe to run more than once.

-- Enums (idempotent create).
DO $$ BEGIN
  CREATE TYPE "ScheduleTriggerType" AS ENUM ('cron', 'event');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ScheduleApprovalMode" AS ENUM ('supervised', 'scheduled', 'autopilot');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ScheduleStatus" AS ENUM ('active', 'paused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SkillRunTrigger" AS ENUM ('cron', 'event', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SkillRunStatus" AS ENUM ('pending', 'awaiting_approval', 'approved', 'running', 'succeeded', 'failed', 'rejected', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- If the enum pre-exists from an earlier partial apply, make sure 'approved' is present.
DO $$ BEGIN
  ALTER TYPE "SkillRunStatus" ADD VALUE IF NOT EXISTS 'approved';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SubagentRunStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tables (idempotent create).
CREATE TABLE IF NOT EXISTS "scheduled_skills" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "project_id" TEXT,
  "skill_id" TEXT NOT NULL,
  "trigger_type" "ScheduleTriggerType" NOT NULL,
  "cron_expr" TEXT,
  "event_source" TEXT,
  "event_config_json" JSONB,
  "created_by" TEXT NOT NULL,
  "approval_mode" "ScheduleApprovalMode" NOT NULL,
  "concurrency_limit" INTEGER NOT NULL DEFAULT 4,
  "status" "ScheduleStatus" NOT NULL DEFAULT 'active',
  "last_run_at" TIMESTAMPTZ(3),
  "next_run_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "scheduled_skills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "skill_runs" (
  "id" TEXT NOT NULL,
  "schedule_id" TEXT,
  "workspace_id" TEXT NOT NULL,
  "project_id" TEXT,
  "skill_id" TEXT NOT NULL,
  "trigger" "SkillRunTrigger" NOT NULL,
  "lineage" TEXT[] NOT NULL DEFAULT '{}',
  "event_payload" JSONB,
  "status" "SkillRunStatus" NOT NULL DEFAULT 'pending',
  "was_missed" BOOLEAN NOT NULL DEFAULT false,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(3),
  "credits_used" INTEGER NOT NULL DEFAULT 0,
  "output_path" TEXT,
  "error" TEXT,
  "approved_by" TEXT,
  "approved_at" TIMESTAMPTZ(3),
  CONSTRAINT "skill_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "subagent_runs" (
  "id" TEXT NOT NULL,
  "skill_run_id" TEXT NOT NULL,
  "task_label" TEXT NOT NULL,
  "status" "SubagentRunStatus" NOT NULL DEFAULT 'pending',
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(3),
  "credits_used" INTEGER NOT NULL DEFAULT 0,
  "result" TEXT,
  CONSTRAINT "subagent_runs_pkey" PRIMARY KEY ("id")
);

-- Indexes (idempotent).
CREATE INDEX IF NOT EXISTS "scheduled_skills_workspace_id_status_idx" ON "scheduled_skills"("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "scheduled_skills_next_run_at_idx" ON "scheduled_skills"("next_run_at");
CREATE INDEX IF NOT EXISTS "scheduled_skills_workspace_id_skill_id_idx" ON "scheduled_skills"("workspace_id", "skill_id");
CREATE INDEX IF NOT EXISTS "skill_runs_workspace_id_started_at_idx" ON "skill_runs"("workspace_id", "started_at");
CREATE INDEX IF NOT EXISTS "skill_runs_schedule_id_idx" ON "skill_runs"("schedule_id");
CREATE INDEX IF NOT EXISTS "skill_runs_skill_id_idx" ON "skill_runs"("skill_id");
CREATE INDEX IF NOT EXISTS "skill_runs_status_idx" ON "skill_runs"("status");
CREATE INDEX IF NOT EXISTS "subagent_runs_skill_run_id_idx" ON "subagent_runs"("skill_run_id");

-- Foreign keys (added only when missing).
DO $$ BEGIN
  ALTER TABLE "scheduled_skills" ADD CONSTRAINT "scheduled_skills_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "scheduled_skills" ADD CONSTRAINT "scheduled_skills_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "scheduled_skills" ADD CONSTRAINT "scheduled_skills_skill_id_fkey"
    FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "scheduled_skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "skill_runs" ADD CONSTRAINT "skill_runs_skill_id_fkey"
    FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "subagent_runs" ADD CONSTRAINT "subagent_runs_skill_run_id_fkey"
    FOREIGN KEY ("skill_run_id") REFERENCES "skill_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Scheduler audit events (idempotent enum additions).
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'schedule_created';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'schedule_updated';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'schedule_paused';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'schedule_resumed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'schedule_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_run_proposed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_run_approved';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_run_rejected';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_run_started';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_run_reported';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_run_finished';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_run_failed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_run_missed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scheduler_cycle_blocked';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'event_fired';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'subagent_run_started';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'subagent_run_finished';
