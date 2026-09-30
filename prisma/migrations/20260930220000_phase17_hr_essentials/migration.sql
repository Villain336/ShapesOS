-- Phase 17 slice 5: HR essentials (team directory + leave requests).
--
--   * ops_team_members: name, title, email, start_date, status
--     (active/inactive). The workspace's team directory.
--   * ops_leave_requests: member ref, type (vacation/sick/personal), date
--     range, status (requested → approved/denied → taken), decided_by/at.
--     Approving a request is a gated write (OPS_LEAVE_APPROVE, medium)
--     through the Phase 14 gate; denying and marking taken are free
--     logged writes. Deleting a member cascades to their leave requests.
--
-- Conventions (mirror the phase-17 migrations):
--   * FK workspace_id -> workspaces(id) ON DELETE CASCADE (tenant scope).
--   * ENABLE + FORCE ROW LEVEL SECURITY; tenant principal is the
--     app.workspace_id GUC. Sessions without the GUC see ZERO rows.
--
-- ERPNext is patterns-only, clean-room: original Marketr work.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE "OpsTeamMemberStatus" AS ENUM ('active', 'inactive');
CREATE TYPE "OpsLeaveType" AS ENUM ('vacation', 'sick', 'personal');
CREATE TYPE "OpsLeaveStatus" AS ENUM ('requested', 'approved', 'denied', 'taken');

-- ---------------------------------------------------------------------------
-- ops_team_members — team directory.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_team_members" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "title" TEXT,
  "email" TEXT,
  "start_date" TIMESTAMPTZ(3),
  "status" "OpsTeamMemberStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_team_members_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_team_members_workspace_id_status_created_at_idx"
  ON "ops_team_members"("workspace_id", "status", "created_at");
CREATE INDEX "ops_team_members_workspace_id_name_idx"
  ON "ops_team_members"("workspace_id", "name");
ALTER TABLE "ops_team_members" ADD CONSTRAINT "ops_team_members_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ops_leave_requests — time-off requests.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_leave_requests" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "member_id" TEXT NOT NULL,
  "type" "OpsLeaveType" NOT NULL,
  "start_date" TIMESTAMPTZ(3) NOT NULL,
  "end_date" TIMESTAMPTZ(3) NOT NULL,
  "status" "OpsLeaveStatus" NOT NULL DEFAULT 'requested',
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_leave_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_leave_requests_workspace_id_member_id_created_at_idx"
  ON "ops_leave_requests"("workspace_id", "member_id", "created_at");
CREATE INDEX "ops_leave_requests_workspace_id_status_created_at_idx"
  ON "ops_leave_requests"("workspace_id", "status", "created_at");
ALTER TABLE "ops_leave_requests" ADD CONSTRAINT "ops_leave_requests_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ops_leave_requests" ADD CONSTRAINT "ops_leave_requests_member_id_fkey"
  FOREIGN KEY ("member_id") REFERENCES "ops_team_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: tenant isolation on the new tables (same pattern as slices 1–4).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_team_members', 'ops_leave_requests'] LOOP
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
