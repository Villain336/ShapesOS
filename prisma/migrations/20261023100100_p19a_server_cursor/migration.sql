-- ShapesOS Phase 19A (WS=server): the agentic cursor (ShapesOS Desktop).
-- agent_runs.budget_micro_usd: a user-set spend cap for a whole run
-- (micro-USD; NULL = platform limits only), enforced in the agent loop and
-- in the Phase 16 budget split. cursor_proposals: actions the cursor's brain
-- proposed that wait for a person's OK; tier / destructive /
-- voice_approvable are server-computed. FORCE RLS on the app.workspace_id
-- GUC (fail-closed), cascading from workspaces and agent_runs. No image or
-- screenshot is ever stored.

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "budget_micro_usd" INTEGER;

-- CreateTable
CREATE TABLE "cursor_proposals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "tool" VARCHAR(200) NOT NULL,
    "args" JSONB NOT NULL DEFAULT '{}',
    "summary" VARCHAR(500) NOT NULL,
    "tier" INTEGER NOT NULL,
    "destructive" BOOLEAN NOT NULL DEFAULT false,
    "voice_approvable" BOOLEAN NOT NULL DEFAULT false,
    "element_id" VARCHAR(200),
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "decided_via" VARCHAR(8),
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "result_summary" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cursor_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cursor_proposals_workspace_id_user_id_status_idx" ON "cursor_proposals"("workspace_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "cursor_proposals_run_id_idx" ON "cursor_proposals"("run_id");

-- AddForeignKey
ALTER TABLE "cursor_proposals" ADD CONSTRAINT "cursor_proposals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cursor_proposals" ADD CONSTRAINT "cursor_proposals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17 migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
ALTER TABLE "cursor_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cursor_proposals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "cursor_proposals_tenant_isolation" ON "cursor_proposals" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
