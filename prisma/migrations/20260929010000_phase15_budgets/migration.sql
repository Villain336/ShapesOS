-- Phase 15 slice 4: per-workspace Composio call budgets + toolkit
-- attribution on ComposioActionLog (spec §§4/5; locked: no packs).
--
-- WorkspaceActionBudget holds one row per workspace: a soft monthly call
-- budget (default 80% alert, fire-once per billing month) or a hard cap
-- (executeApproved refuses fail-closed when exhausted). Null
-- monthly_call_budget = no workspace budget configured.
-- ComposioActionLog.toolkit_slug is NULL for rows written before this
-- slice (or where toolkit resolution failed); they fall in the "unknown"
-- attribution bucket.

ALTER TABLE "composio_action_logs"
  ADD COLUMN "toolkit_slug" TEXT;
CREATE INDEX "composio_action_logs_workspace_id_toolkit_slug_created_at_idx"
  ON "composio_action_logs"("workspace_id", "toolkit_slug", "created_at");

CREATE TABLE "workspace_action_budgets" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "monthly_call_budget" INTEGER,
  "hard_cap" BOOLEAN NOT NULL DEFAULT false,
  "alert_threshold_pct" INTEGER NOT NULL DEFAULT 80,
  "last_alerted_pct" INTEGER,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_action_budgets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_action_budgets_workspace_id_key"
  ON "workspace_action_budgets"("workspace_id");
ALTER TABLE "workspace_action_budgets" ADD CONSTRAINT "workspace_action_budgets_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: same tenant-isolation pattern as phase 14 / phase 15
-- slices 1–3. ENABLE + FORCE; tenant principal is the
-- app.workspace_id GUC. Sessions without the GUC see ZERO rows
-- (fail-closed).
-- ============================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "workspace_action_budgets" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "workspace_action_budgets" FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY workspace_action_budgets_tenant_isolation ON "workspace_action_budgets" FOR ALL ' ||
          'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
          'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))';
END $$;
