-- ShapesOS Phase 11 (conncore): HubSpot <-> Ops CRM bidirectional sync.
--
-- hubspot_sync_links: one row per mapped object (contact | company | deal |
-- pipeline) — HubSpot id <-> local ops_* / crm_pipelines id, plus both
-- sides' updatedAt at the last sync (the conflict rule's inputs,
-- lib/hubspot/sync.ts). The two unique indexes make the mapping idempotent.
-- FORCE RLS on the app.workspace_id GUC; cascades from workspaces.

-- CreateTable
CREATE TABLE "hubspot_sync_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "hubspot_id" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "hubspot_updated_at" TIMESTAMP(3),
    "local_updated_at" TIMESTAMP(3),
    "last_direction" TEXT NOT NULL DEFAULT 'pull',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hubspot_sync_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hubspot_sync_links_workspace_id_object_type_hubspot_id_key" ON "hubspot_sync_links"("workspace_id", "object_type", "hubspot_id");

-- CreateIndex
CREATE UNIQUE INDEX "hubspot_sync_links_workspace_id_object_type_local_id_key" ON "hubspot_sync_links"("workspace_id", "object_type", "local_id");

-- AddForeignKey
ALTER TABLE "hubspot_sync_links" ADD CONSTRAINT "hubspot_sync_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: tenant isolation on app.workspace_id (fail-closed).
-- ============================================================
ALTER TABLE "hubspot_sync_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hubspot_sync_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY hubspot_sync_links_tenant_isolation ON "hubspot_sync_links" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
