-- Legal/Compliance slice 2: Deadline engine (BUSINESS-OS-FEATURE-SPECS.md §4).
--
-- LegalDeadline holds per-tenant computed deadlines for obligations. The
-- tenant sets/confirms the due date (source "tenant_set"); recurring
-- reminders are computed from the renewal cadence anchored to that real date
-- (source "computed"). A null due_date is ALWAYS "date needed" — the engine
-- never invents calendar dates. Escalation tiers (90/30/7 days, overdue) are
-- computed at read time; last_alerted_tier records the tier the sweep
-- already emitted so each tier fires at most once per deadline.

-- CreateEnum
CREATE TYPE "DeadlineRecurrence" AS ENUM ('none', 'monthly', 'quarterly', 'semiannual', 'annual', 'biennial');

-- CreateEnum
CREATE TYPE "DeadlineSource" AS ENUM ('tenant_set', 'computed');

-- CreateEnum
CREATE TYPE "DeadlineStatus" AS ENUM ('open', 'done', 'dismissed');

-- CreateTable
CREATE TABLE "legal_deadlines" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "template_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "due_date" TIMESTAMP(3),
    "recurrence" "DeadlineRecurrence" NOT NULL DEFAULT 'none',
    "source" "DeadlineSource" NOT NULL DEFAULT 'tenant_set',
    "status" "DeadlineStatus" NOT NULL DEFAULT 'open',
    "last_alerted_tier" TEXT,
    "last_alerted_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_deadlines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_deadlines_workspace_id_status_idx" ON "legal_deadlines"("workspace_id", "status");
CREATE INDEX "legal_deadlines_workspace_id_due_date_idx" ON "legal_deadlines"("workspace_id", "due_date");

-- AddForeignKey
ALTER TABLE "legal_deadlines" ADD CONSTRAINT "legal_deadlines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
