-- Phase 15 slice 1: ComposioToolCatalog — per-workspace discovered tool cache.
-- Replaces the static V1_ACTION_CATALOG pinning with live discovery; the v1
-- catalog itself stays as the verified baseline. Slugs + metadata only —
-- Composio tools remain Composio's IP (no implementations stored).

CREATE TABLE "composio_tool_catalog" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "app_key" TEXT NOT NULL,
  "toolkit_slug" TEXT NOT NULL,
  "tool_slug" TEXT NOT NULL,
  "tool_label" TEXT,
  "description" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "discovered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "composio_tool_catalog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "composio_tool_catalog_workspace_id_toolkit_slug_tool_slug_key"
  ON "composio_tool_catalog"("workspace_id", "toolkit_slug", "tool_slug");
CREATE INDEX "composio_tool_catalog_workspace_id_app_key_idx"
  ON "composio_tool_catalog"("workspace_id", "app_key");
ALTER TABLE "composio_tool_catalog" ADD CONSTRAINT "composio_tool_catalog_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: same tenant-isolation pattern as phase 14 (docs/phases/…).
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "composio_tool_catalog" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "composio_tool_catalog" FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY composio_tool_catalog_tenant_isolation ON "composio_tool_catalog" FOR ALL ' ||
          'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
          'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))';
END $$;
