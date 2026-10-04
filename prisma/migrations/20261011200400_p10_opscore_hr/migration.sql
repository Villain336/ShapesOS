-- ShapesOS Phase 10 (ops-core): HR — departments, team member ↔ workspace
-- user link, leave policies (yearly accrual + carry-over cap) and an
-- append-only leave ledger, recruiting (job openings + applicants).
-- New tables are FORCE RLS on app.workspace_id and cascade from workspaces.

-- CreateEnum
CREATE TYPE "OpsLeaveLedgerKind" AS ENUM ('taken', 'adjustment');

-- CreateEnum
CREATE TYPE "OpsJobOpeningStatus" AS ENUM ('open', 'paused', 'closed');

-- CreateEnum
CREATE TYPE "OpsApplicantStage" AS ENUM ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected');

-- AlterTable
ALTER TABLE "ops_team_members" ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "user_id" TEXT;

-- CreateTable
CREATE TABLE "ops_departments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manager_member_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_leave_policies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "type" "OpsLeaveType" NOT NULL,
    "yearly_days" INTEGER NOT NULL,
    "carry_over_cap_days" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_leave_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_leave_ledger" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "type" "OpsLeaveType" NOT NULL,
    "year" INTEGER NOT NULL,
    "kind" "OpsLeaveLedgerKind" NOT NULL,
    "centidays" INTEGER NOT NULL,
    "leave_request_id" TEXT,
    "note" TEXT,
    "actor" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_leave_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_job_openings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department_id" TEXT,
    "location" TEXT,
    "description" TEXT,
    "status" "OpsJobOpeningStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_job_openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_applicants" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "opening_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "source" TEXT,
    "stage" "OpsApplicantStage" NOT NULL DEFAULT 'applied',
    "rating" INTEGER,
    "notes" TEXT,
    "hired_member_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_applicants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_departments_workspace_id_name_key" ON "ops_departments"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ops_leave_policies_workspace_id_type_key" ON "ops_leave_policies"("workspace_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ops_leave_ledger_leave_request_id_key" ON "ops_leave_ledger"("leave_request_id");

-- CreateIndex
CREATE INDEX "ops_leave_ledger_workspace_id_member_id_type_year_idx" ON "ops_leave_ledger"("workspace_id", "member_id", "type", "year");

-- CreateIndex
CREATE INDEX "ops_job_openings_workspace_id_status_idx" ON "ops_job_openings"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "ops_applicants_workspace_id_opening_id_stage_idx" ON "ops_applicants"("workspace_id", "opening_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "ops_team_members_workspace_id_user_id_key" ON "ops_team_members"("workspace_id", "user_id");

-- AddForeignKey
ALTER TABLE "ops_departments" ADD CONSTRAINT "ops_departments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_departments" ADD CONSTRAINT "ops_departments_manager_member_id_fkey" FOREIGN KEY ("manager_member_id") REFERENCES "ops_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_leave_policies" ADD CONSTRAINT "ops_leave_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_leave_ledger" ADD CONSTRAINT "ops_leave_ledger_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_leave_ledger" ADD CONSTRAINT "ops_leave_ledger_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "ops_team_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_job_openings" ADD CONSTRAINT "ops_job_openings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_job_openings" ADD CONSTRAINT "ops_job_openings_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "ops_departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_applicants" ADD CONSTRAINT "ops_applicants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_applicants" ADD CONSTRAINT "ops_applicants_opening_id_fkey" FOREIGN KEY ("opening_id") REFERENCES "ops_job_openings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_team_members" ADD CONSTRAINT "ops_team_members_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "ops_departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17 migrations.
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_departments', 'ops_leave_policies', 'ops_leave_ledger', 'ops_job_openings', 'ops_applicants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
