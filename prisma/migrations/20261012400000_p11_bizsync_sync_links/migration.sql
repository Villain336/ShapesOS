-- ShapesOS Phase 11 (bizsync): Shopify / QuickBooks Online / Xero <-> Ops sync.
--
-- biz_sync_links: one row per mapped object, keyed by provider — remote id
-- <-> local ops_* id, the remote updatedAt and a fingerprint of the local
-- mapped fields at the last sync (conflict rule inputs, lib/bizsync/links.ts).
-- The two unique indexes make every pull / push idempotent.
-- biz_sync_runs: the run log the Settings -> Connectors -> Business sync page
-- shows (status, last run, errors).
-- FORCE RLS on the app.workspace_id GUC; both cascade from workspaces.

-- CreateTable
CREATE TABLE "biz_sync_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "remote_id" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "remote_updated_at" TIMESTAMP(3),
    "local_hash" TEXT,
    "local_updated_at" TIMESTAMP(3),
    "last_direction" TEXT NOT NULL DEFAULT 'pull',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "biz_sync_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biz_sync_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "actor" TEXT NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "biz_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "biz_sync_links_workspace_id_provider_object_type_remote_id_key" ON "biz_sync_links"("workspace_id", "provider", "object_type", "remote_id");

-- CreateIndex
CREATE UNIQUE INDEX "biz_sync_links_workspace_id_provider_object_type_local_id_key" ON "biz_sync_links"("workspace_id", "provider", "object_type", "local_id");

-- CreateIndex
CREATE INDEX "biz_sync_runs_workspace_id_provider_started_at_idx" ON "biz_sync_runs"("workspace_id", "provider", "started_at");

-- AddForeignKey
ALTER TABLE "biz_sync_links" ADD CONSTRAINT "biz_sync_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biz_sync_runs" ADD CONSTRAINT "biz_sync_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ============================================================
-- RLS: tenant isolation on app.workspace_id (fail-closed).
-- ============================================================
ALTER TABLE "biz_sync_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "biz_sync_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY biz_sync_links_tenant_isolation ON "biz_sync_links" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE "biz_sync_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "biz_sync_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY biz_sync_runs_tenant_isolation ON "biz_sync_runs" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
