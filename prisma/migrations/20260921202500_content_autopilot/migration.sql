-- Marketr milestone 18: content autopilot with approval gates and kill switch.
-- (Hand-written — no PostgreSQL in sandbox; review before deploy.)

-- New enums
CREATE TYPE "AutopilotSource" AS ENUM ('decay_refresh', 'programmatic_template', 'keyword_opportunity');
CREATE TYPE "AutopilotCadence" AS ENUM ('daily', 'weekly', 'manual');
CREATE TYPE "AutopilotRunStatus" AS ENUM ('running', 'completed', 'failed', 'killed');
CREATE TYPE "AutopilotItemKind" AS ENUM ('decay_refresh', 'programmatic_page', 'keyword_brief');
CREATE TYPE "AutopilotItemStatus" AS ENUM ('pending', 'approved', 'rejected', 'published', 'killed');

-- Audit enum additions (Postgres >= 9.1 supports ADD VALUE)
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_rule_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_rule_updated';
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_rule_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_run_started';
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_run_finished';
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_item_generated';
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_item_approved';
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_item_rejected';
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_item_published';
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_killed';
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_unkilled';

-- Autopilot rules
CREATE TABLE "autopilot_rules" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "AutopilotSource" NOT NULL,
    "programmatic_template_id" TEXT,
    "cadence" "AutopilotCadence" NOT NULL DEFAULT 'manual',
    "max_items_per_run" INTEGER NOT NULL DEFAULT 5,
    "auto_approve" BOOLEAN NOT NULL DEFAULT false,
    "publish_target" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "autopilot_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "autopilot_rules_project_id_enabled_idx" ON "autopilot_rules"("project_id", "enabled");

-- Autopilot runs
CREATE TABLE "autopilot_runs" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "AutopilotRunStatus" NOT NULL DEFAULT 'running',
    "items_generated" INTEGER NOT NULL DEFAULT 0,
    "items_approved" INTEGER NOT NULL DEFAULT 0,
    "items_published" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "autopilot_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "autopilot_runs_rule_id_started_at_idx" ON "autopilot_runs"("rule_id", "started_at");
CREATE INDEX "autopilot_runs_project_id_started_at_idx" ON "autopilot_runs"("project_id", "started_at");

-- Autopilot items (approval queue)
CREATE TABLE "autopilot_items" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" "AutopilotItemKind" NOT NULL,
    "source_ref" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "draft_json" JSONB,
    "draft_markdown" TEXT,
    "status" "AutopilotItemStatus" NOT NULL DEFAULT 'pending',
    "auto_approved" BOOLEAN NOT NULL DEFAULT false,
    "review_note" TEXT,
    "published_url" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "autopilot_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "autopilot_items_rule_id_kind_source_ref_key" ON "autopilot_items"("rule_id", "kind", "source_ref");
CREATE INDEX "autopilot_items_project_id_status_idx" ON "autopilot_items"("project_id", "status");
CREATE INDEX "autopilot_items_run_id_status_idx" ON "autopilot_items"("run_id", "status");

-- Kill switches (workspace- or project-scoped)
CREATE TABLE "autopilot_kill_switches" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "project_id" TEXT,
    "scope_key" TEXT NOT NULL,
    "killed" BOOLEAN NOT NULL DEFAULT false,
    "killed_at" TIMESTAMP(3),
    "killed_by" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "autopilot_kill_switches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "autopilot_kill_switches_scope_key_key" UNIQUE ("scope_key")
);

-- Foreign keys
ALTER TABLE "autopilot_rules" ADD CONSTRAINT "autopilot_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "autopilot_rules" ADD CONSTRAINT "autopilot_rules_programmatic_template_id_fkey" FOREIGN KEY ("programmatic_template_id") REFERENCES "programmatic_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "autopilot_runs" ADD CONSTRAINT "autopilot_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "autopilot_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "autopilot_runs" ADD CONSTRAINT "autopilot_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "autopilot_items" ADD CONSTRAINT "autopilot_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "autopilot_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "autopilot_items" ADD CONSTRAINT "autopilot_items_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "autopilot_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "autopilot_items" ADD CONSTRAINT "autopilot_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "autopilot_kill_switches" ADD CONSTRAINT "autopilot_kill_switches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "autopilot_kill_switches" ADD CONSTRAINT "autopilot_kill_switches_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
