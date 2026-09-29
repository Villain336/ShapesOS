-- Phase 15 slice 3: WorkspaceToolkit — per-workspace toolkit enablement.
-- The full firehose directory is visible to every workspace (locked: no
-- packs); agents can only propose tools whose toolkit is enabled for the
-- workspace. The v1 five toolkits (gmail, google_sheets, slack, hubspot,
-- notion) are enabled-by-default in code (lib/integrations/actions/toolkits.ts)
-- so existing workspaces see zero regression — they need no row here.
-- A row records an explicit workspace decision (enabled=true/false).

CREATE TABLE "workspace_toolkits" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "toolkit_slug" TEXT NOT NULL,
  "app_key" TEXT,
  "enabled_by" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "enabled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_toolkits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workspace_toolkits_workspace_id_toolkit_slug_key"
  ON "workspace_toolkits"("workspace_id", "toolkit_slug");
CREATE INDEX "workspace_toolkits_workspace_id_enabled_idx"
  ON "workspace_toolkits"("workspace_id", "enabled");
ALTER TABLE "workspace_toolkits" ADD CONSTRAINT "workspace_toolkits_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: same tenant-isolation pattern as phase 14 / phase 15 slice 1.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "workspace_toolkits" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "workspace_toolkits" FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY workspace_toolkits_tenant_isolation ON "workspace_toolkits" FOR ALL ' ||
          'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
          'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))';
END $$;
