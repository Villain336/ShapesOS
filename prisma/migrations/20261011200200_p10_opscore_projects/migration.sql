-- ShapesOS Phase 10 (ops-core): project tasks + timesheets.
-- ops_tasks (kanban stages, priority, assignee = workspace member subject),
-- ops_time_entries gains user/rate/task/approval/invoice columns, and
-- ops_projects a default hourly rate. Pre-existing time entries predate
-- approval: they are marked approved so already-logged work stays billable.
-- ops_tasks is FORCE RLS on app.workspace_id and cascades from workspaces.

-- CreateEnum
CREATE TYPE "OpsTaskStage" AS ENUM ('backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "OpsTaskPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "OpsTimesheetStatus" AS ENUM ('pending', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "ops_projects" ADD COLUMN     "hourly_rate_cents" INTEGER;

-- AlterTable
ALTER TABLE "ops_time_entries" ADD COLUMN     "approval_status" "OpsTimesheetStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by" TEXT,
ADD COLUMN     "billable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoice_id" TEXT,
ADD COLUMN     "rate_cents" INTEGER,
ADD COLUMN     "task_id" TEXT,
ADD COLUMN     "user_id" TEXT;

-- CreateTable
CREATE TABLE "ops_tasks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "stage" "OpsTaskStage" NOT NULL DEFAULT 'todo',
    "priority" "OpsTaskPriority" NOT NULL DEFAULT 'normal',
    "assignee_id" TEXT,
    "due_at" TIMESTAMP(3),
    "estimate_minutes" INTEGER,
    "completed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ops_tasks_workspace_id_project_id_stage_idx" ON "ops_tasks"("workspace_id", "project_id", "stage");

-- CreateIndex
CREATE INDEX "ops_tasks_workspace_id_assignee_id_stage_idx" ON "ops_tasks"("workspace_id", "assignee_id", "stage");

-- CreateIndex
CREATE INDEX "ops_time_entries_workspace_id_approval_status_user_id_idx" ON "ops_time_entries"("workspace_id", "approval_status", "user_id");

-- CreateIndex
CREATE INDEX "ops_time_entries_workspace_id_invoice_id_idx" ON "ops_time_entries"("workspace_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "ops_tasks" ADD CONSTRAINT "ops_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_tasks" ADD CONSTRAINT "ops_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "ops_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_time_entries" ADD CONSTRAINT "ops_time_entries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "ops_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: legacy entries are approved (they were never subject to approval)
-- and attributed to the actor when it looks like a user id.
UPDATE "ops_time_entries" SET "approval_status" = 'approved' WHERE "approval_status" = 'pending';
UPDATE "ops_time_entries" SET "user_id" = "actor" WHERE "user_id" IS NULL AND "actor" IS NOT NULL AND "actor" NOT LIKE 'agent:%';

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17 migrations.
-- ============================================================
ALTER TABLE "ops_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ops_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ops_tasks_tenant_isolation" ON "ops_tasks" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
