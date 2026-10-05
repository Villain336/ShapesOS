-- ShapesOS Phase 16 (deleg): automatic parallel delegation.
--
-- 1. AgentRunStatus gains `awaiting_confirmation`: a delegated sub-agent with
--    proposals waiting for the user's OK (and the lead waiting on them) is
--    neither running nor finished. "yes" resumes it; Stop cancels it. It is
--    NOT terminal (lib/agents/runs/types.ts TERMINAL_RUN_STATUSES).
-- 2. agent_delegation_settings: one row per workspace — the "Automatic
--    delegation" switch (default on) and the delegation limits (null = the
--    code default: 4 parallel per run, 6 live per workspace, 8 per plan,
--    depth 2; lib/agents/delegation/plan.ts). FORCE RLS on app.workspace_id,
--    cascades from the workspace.
--
-- The plan itself lives on the delegating run (agent_runs.agent_state
-- ->'delegation'); children are ordinary agent_runs rows (parent_run_id) run
-- by `subagent_run` agent_jobs — no other new tables.

-- AlterEnum
ALTER TYPE "AgentRunStatus" ADD VALUE 'awaiting_confirmation';

-- CreateTable
CREATE TABLE "agent_delegation_settings" (
    "workspace_id" TEXT NOT NULL,
    "auto_delegation" BOOLEAN NOT NULL DEFAULT true,
    "max_parallel_per_run" INTEGER,
    "max_live_per_workspace" INTEGER,
    "max_width" INTEGER,
    "max_depth" INTEGER,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_delegation_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- AddForeignKey
ALTER TABLE "agent_delegation_settings" ADD CONSTRAINT "agent_delegation_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: the repo's tenant-isolation pattern (ENABLE + FORCE; the tenant
-- principal is the app.workspace_id GUC; no GUC → zero rows, fail-closed).
-- ============================================================
ALTER TABLE "agent_delegation_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_delegation_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "agent_delegation_settings_tenant_isolation" ON "agent_delegation_settings" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
