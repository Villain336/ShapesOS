-- ShapesOS Phase 11 (seotools): sitemap submissions for SiteBuilder / IDE
-- sites — Google Search Console (connected property) or IndexNow (keyless).
-- A submission that did not reach the engine is recorded with its real
-- status (not_connected / needs_reconnect / failed), never as submitted.
-- FORCE RLS on the app.workspace_id GUC (fail-closed); cascades from
-- workspaces and sites.

-- CreateTable
CREATE TABLE "site_sitemap_submissions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sitemap_url" TEXT NOT NULL,
    "url_count" INTEGER NOT NULL DEFAULT 0,
    "http_status" INTEGER,
    "detail" TEXT,
    "submitted_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_sitemap_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_sitemap_submissions_workspace_id_site_id_created_at_idx" ON "site_sitemap_submissions"("workspace_id", "site_id", "created_at");

-- AddForeignKey
ALTER TABLE "site_sitemap_submissions" ADD CONSTRAINT "site_sitemap_submissions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_sitemap_submissions" ADD CONSTRAINT "site_sitemap_submissions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17, 4a, 8 and 9
-- migrations. ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
ALTER TABLE "site_sitemap_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_sitemap_submissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_sitemap_submissions_tenant_isolation" ON "site_sitemap_submissions" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
