-- ShapesOS Phase 9 (sites): agent site drafts, Netlify deploys, one-click
-- rollback.
--   * site_revisions — full snapshots of a site's working copy that are NOT
--     live: agent drafts (site_publish_draft) and the backup saved before a
--     person applies one. FORCE RLS on the app.workspace_id GUC
--     (fail-closed), cascades from workspaces and sites.
--   * DeployTargetType gains 'netlify'.
--   * deployments gains provider_project (Vercel project / Pages project /
--     Netlify site the deploy went to) and rollback_of (the row a rollback
--     restored).

-- AlterEnum
ALTER TYPE "DeployTargetType" ADD VALUE 'netlify';

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "provider_project" TEXT,
ADD COLUMN     "rollback_of" TEXT;

-- CreateTable
CREATE TABLE "site_revisions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'agent',
    "run_id" TEXT,
    "summary" TEXT,
    "files" JSONB NOT NULL DEFAULT '[]',
    "file_count" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "patch" TEXT,
    "patch_truncated" BOOLEAN NOT NULL DEFAULT false,
    "base_fingerprint" TEXT,
    "created_by" TEXT,
    "applied_at" TIMESTAMP(3),
    "applied_by" TEXT,
    "backup_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_revisions_workspace_id_site_id_created_at_idx" ON "site_revisions"("workspace_id", "site_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "site_revisions_site_id_number_key" ON "site_revisions"("site_id", "number");

-- AddForeignKey
ALTER TABLE "site_revisions" ADD CONSTRAINT "site_revisions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_revisions" ADD CONSTRAINT "site_revisions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17, 4a and 8 migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
ALTER TABLE "site_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "site_revisions_tenant_isolation" ON "site_revisions" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
