-- Marketr milestone 11: enterprise security — RBAC membership + workspace-scoped audit.
-- Postgres 16: ALTER TYPE ... ADD VALUE is transaction-safe.

-- 1. WorkspaceRole enum
CREATE TYPE "WorkspaceRole" AS ENUM ('owner', 'admin', 'editor', 'viewer');

-- 2. workspace_members table
CREATE TABLE "workspace_members" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT,
  "email" TEXT,
  "name" TEXT,
  "role" "WorkspaceRole" NOT NULL DEFAULT 'viewer',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");
CREATE UNIQUE INDEX "workspace_members_workspace_id_email_key" ON "workspace_members"("workspace_id", "email");
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");
ALTER TABLE "workspace_members"
  ADD CONSTRAINT "workspace_members_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Backfill: every existing workspace owner becomes an owner member.
INSERT INTO "workspace_members" ("id", "workspace_id", "user_id", "role", "created_at", "updated_at")
SELECT 'wsm_' || md5("id" || "owner_user_id"), "id", "owner_user_id", 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "workspaces"
ON CONFLICT DO NOTHING;

-- 4. FileChangeLog: workspace-scoped audit support.
ALTER TABLE "file_change_log" ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "file_change_log" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "file_change_log"
  ADD CONSTRAINT "file_change_log_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. New audit actions (credential lifecycle + membership).
ALTER TYPE "FileChangeAction" ADD VALUE 'credential_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'credential_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'member_added';
ALTER TYPE "FileChangeAction" ADD VALUE 'member_role_changed';
ALTER TYPE "FileChangeAction" ADD VALUE 'member_removed';
