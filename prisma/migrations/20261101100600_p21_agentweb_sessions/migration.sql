-- ShapesOS Phase 21A round 2 (WS=agentweb): Agent Sessions (M5).
-- agentweb_sessions: the browsing-session state of ONE agent run (control, step approval,
--   caps, origins); extends agent_runs, never replaces it. FORCE RLS.
-- agentweb_flows: recorded web flows ("teach once"), drafts until a person publishes. FORCE RLS.

-- CreateTable
CREATE TABLE "agentweb_sessions" (
    "run_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "started_by" TEXT NOT NULL,
    "task_key" TEXT NOT NULL,
    "control" VARCHAR(10) NOT NULL DEFAULT 'agent',
    "control_by" TEXT,
    "control_at" TIMESTAMP(3),
    "step_mode" VARCHAR(12) NOT NULL DEFAULT 'auto',
    "pending" JSONB,
    "last_note" TEXT,
    "max_steps" INTEGER NOT NULL DEFAULT 60,
    "max_seconds" INTEGER NOT NULL DEFAULT 1800,
    "max_credits" INTEGER NOT NULL DEFAULT 150,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "current_url" TEXT,
    "channel" VARCHAR(24),
    "origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "needs_reason" VARCHAR(24),
    "ended_reason" VARCHAR(24),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_step_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agentweb_sessions_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "agentweb_flows" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source_run_id" TEXT,
    "spec" JSONB NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'draft',
    "created_by" TEXT NOT NULL,
    "published_by" TEXT,
    "published_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_run_status" VARCHAR(16),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agentweb_flows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agentweb_sessions_workspace_id_started_at_idx" ON "agentweb_sessions"("workspace_id", "started_at");

-- CreateIndex
CREATE INDEX "agentweb_sessions_workspace_id_needs_reason_idx" ON "agentweb_sessions"("workspace_id", "needs_reason");

-- CreateIndex
CREATE INDEX "agentweb_flows_workspace_id_status_created_at_idx" ON "agentweb_flows"("workspace_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "agentweb_sessions" ADD CONSTRAINT "agentweb_sessions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentweb_sessions" ADD CONSTRAINT "agentweb_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentweb_flows" ADD CONSTRAINT "agentweb_flows_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: same tenant-isolation pattern as the phase 4a / 18 migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['agentweb_sessions', 'agentweb_flows'] LOOP
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
