-- ShapesOS Phase 8 (sandbox): agent_run_sandboxes — the code sandbox an agent
-- run works in (lib/sandbox). One row per run (run_id unique) recording the
-- provider, the provider's sandbox id, the ports exposed for previews and when
-- it was destroyed. Cascades from workspaces and agent_runs. FORCE RLS on the
-- app.workspace_id GUC (fail-closed), same pattern as the phase-16 run tables.
-- CreateTable
CREATE TABLE "agent_run_sandboxes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sandbox_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "exposed_ports" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destroyed_at" TIMESTAMP(3),

    CONSTRAINT "agent_run_sandboxes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_sandboxes_run_id_key" ON "agent_run_sandboxes"("run_id");

-- CreateIndex
CREATE INDEX "agent_run_sandboxes_workspace_id_status_idx" ON "agent_run_sandboxes"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "agent_run_sandboxes" ADD CONSTRAINT "agent_run_sandboxes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_sandboxes" ADD CONSTRAINT "agent_run_sandboxes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
ALTER TABLE "agent_run_sandboxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_run_sandboxes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "agent_run_sandboxes_tenant_isolation" ON "agent_run_sandboxes" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
