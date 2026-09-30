-- Phase 17 slice 4: project time-entry ledger.
--
--   * ops_time_entries: project ref, duration in INTEGER minutes (never
--     floats — the same integer-math discipline as money), description,
--     actor (user id or "agent:<surface>"), occurred_at, billed flag.
--     Append-only: log new rows to correct, never edit history.
--     ON DELETE CASCADE on project_id (deleting a project drops its
--     ledger) and workspace_id (tenant scope).
--
-- Conventions (mirror the phase-17 migrations):
--   * FK workspace_id -> workspaces(id) ON DELETE CASCADE (tenant scope).
--   * ENABLE + FORCE ROW LEVEL SECURITY; tenant principal is the
--     app.workspace_id GUC. Sessions without the GUC see ZERO rows.
--
-- ERPNext is patterns-only, clean-room: original Marketr work.

-- ---------------------------------------------------------------------------
-- ops_time_entries — project time ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_time_entries" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "minutes" INTEGER NOT NULL,
  "description" TEXT,
  "actor" TEXT,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "billed" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_time_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_time_entries_workspace_id_project_id_occurred_at_idx"
  ON "ops_time_entries"("workspace_id", "project_id", "occurred_at");
CREATE INDEX "ops_time_entries_workspace_id_project_id_billed_idx"
  ON "ops_time_entries"("workspace_id", "project_id", "billed");
ALTER TABLE "ops_time_entries" ADD CONSTRAINT "ops_time_entries_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ops_time_entries" ADD CONSTRAINT "ops_time_entries_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "ops_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: tenant isolation on the new table (same pattern as slice 1).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_time_entries'] LOOP
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
