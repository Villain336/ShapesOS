-- Phase 15 slice 5: ComposioCatalogDrift — per-workspace catalog drift reports.
-- detectDrift() diffs fresh discovery vs the ComposioToolCatalog cache;
-- recordDriftReport() persists one row per change (added|removed|renamed).
-- Removed tools keep their last-known cache rows (slice-1 behavior); the
-- drift row is what flags them. Slugs + metadata only — Composio tools
-- remain Composio's IP (no implementations stored).

CREATE TABLE "composio_catalog_drift" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "app_key" TEXT NOT NULL,
  "toolkit_slug" TEXT NOT NULL,
  "change_type" TEXT NOT NULL,
  "tool_slug" TEXT NOT NULL,
  "old_slug" TEXT,
  "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged_at" TIMESTAMPTZ(3),
  CONSTRAINT "composio_catalog_drift_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "composio_catalog_drift_workspace_id_detected_at_idx"
  ON "composio_catalog_drift"("workspace_id", "detected_at");
ALTER TABLE "composio_catalog_drift" ADD CONSTRAINT "composio_catalog_drift_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: same tenant-isolation pattern as phase 15 slice 1.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "composio_catalog_drift" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "composio_catalog_drift" FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY composio_catalog_drift_tenant_isolation ON "composio_catalog_drift" FOR ALL ' ||
          'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
          'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))';
END $$;
