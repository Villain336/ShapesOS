-- Phase 5: the four "not real yet" agent controls, enforced server-side.
--   * agent_runs: which agent ran (agent_key), the sub-agent tree
--     (parent_run_id), the granted tool groups (allowed_tools) and a
--     cooperative stop request (cancel_requested_at/_by).
--   * ai_chat_threads: the task's agent and tool grant.
--   * automation_settings: per-agent auto-approve rules ("*" = every agent,
--     so every existing row keeps its meaning).
-- agent_runs keeps its FORCE RLS policy (workspace_id) unchanged.

-- AlterEnum
ALTER TYPE "AgentRunKind" ADD VALUE IF NOT EXISTS 'chat';

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "agent_key" TEXT,
ADD COLUMN     "allowed_tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cancel_requested_at" TIMESTAMP(3),
ADD COLUMN     "cancel_requested_by" TEXT,
ADD COLUMN     "parent_run_id" TEXT;

CREATE INDEX "agent_runs_workspace_id_parent_run_id_idx" ON "agent_runs"("workspace_id", "parent_run_id");

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ai_chat_threads" ADD COLUMN     "agent_key" TEXT NOT NULL DEFAULT 'lead',
ADD COLUMN     "allowed_tools" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable: per-agent automation rules. The old (workspace, action) key was
-- created as a table constraint, so drop it as one.
ALTER TABLE "automation_settings" ADD COLUMN     "agent_key" TEXT NOT NULL DEFAULT '*';
ALTER TABLE "automation_settings" DROP CONSTRAINT IF EXISTS "automation_settings_workspace_id_action_key";
DROP INDEX IF EXISTS "automation_settings_workspace_id_action_key";
CREATE UNIQUE INDEX "automation_settings_workspace_id_agent_key_action_key" ON "automation_settings"("workspace_id", "agent_key", "action");
