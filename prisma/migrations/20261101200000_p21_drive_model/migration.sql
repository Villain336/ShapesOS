-- ShapesOS Phase 21B (WS=drive): the virtual file system, model (additive only).
-- Folders become rows; files gain an owner (private homes), a case/NFC-insensitive
-- path key, tags and a trash batch; the change journal (per-workspace sequence),
-- scope quotas, multipart uploads, favourites, smart folders and agent run folder
-- grants. Existing workspace_files rows are NOT rewritten here (the next migration
-- fills the new columns for them without changing logical_path).
-- Every new table is FORCE RLS on the app.workspace_id GUC (fail-closed) and
-- cascades from workspaces.

-- AlterTable
ALTER TABLE "workspace_files" ADD COLUMN     "owner_user_id" TEXT,
ADD COLUMN     "path_key" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "trash_batch" TEXT;

-- CreateTable
CREATE TABLE "workspace_folders" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "path_key" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "parent_id" TEXT,
    "owner_user_id" TEXT,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "color" VARCHAR(16),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "trashed_at" TIMESTAMP(3),
    "trash_batch" TEXT,

    CONSTRAINT "workspace_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_folder_acls" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "folder_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" VARCHAR(16) NOT NULL,
    "granted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_folder_acls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_drive_cursors" (
    "workspace_id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT 0,
    "floor_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "workspace_drive_cursors_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "workspace_drive_changes" (
    "workspace_id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "entity" VARCHAR(8) NOT NULL,
    "entity_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "prev_path" TEXT,
    "version" INTEGER,
    "actor_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_drive_changes_pkey" PRIMARY KEY ("workspace_id","seq")
);

-- CreateTable
CREATE TABLE "workspace_drive_quotas" (
    "workspace_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "limit_bytes" BIGINT,
    "used_bytes" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "workspace_drive_quotas_pkey" PRIMARY KEY ("workspace_id","scope")
);

-- CreateTable
CREATE TABLE "workspace_uploads" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "logical_path" TEXT NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mime_type" TEXT NOT NULL,
    "total_bytes" BIGINT NOT NULL,
    "part_size" INTEGER NOT NULL,
    "part_count" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'initiated',
    "parts" JSONB NOT NULL DEFAULT '{}',
    "storage_key" TEXT NOT NULL,
    "provider_upload_id" TEXT,
    "replace_file_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "completed_file_id" TEXT,

    CONSTRAINT "workspace_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_drive_favorites" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "entity" VARCHAR(8) NOT NULL,
    "entity_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_drive_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_smart_folders" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "query" VARCHAR(500) NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_smart_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_folders" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "folder_path" TEXT NOT NULL,
    "attached_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_folders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workspace_folders_workspace_id_parent_id_idx" ON "workspace_folders"("workspace_id", "parent_id");

-- CreateIndex
CREATE INDEX "workspace_folders_workspace_id_owner_user_id_idx" ON "workspace_folders"("workspace_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "workspace_folders_workspace_id_path_idx" ON "workspace_folders"("workspace_id", "path");

-- CreateIndex
CREATE INDEX "workspace_folder_acls_workspace_id_user_id_idx" ON "workspace_folder_acls"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_folder_acls_folder_id_user_id_key" ON "workspace_folder_acls"("folder_id", "user_id");

-- CreateIndex
CREATE INDEX "workspace_drive_changes_workspace_id_entity_id_idx" ON "workspace_drive_changes"("workspace_id", "entity_id");

-- CreateIndex
CREATE INDEX "workspace_drive_changes_workspace_id_created_at_idx" ON "workspace_drive_changes"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_uploads_storage_key_key" ON "workspace_uploads"("storage_key");

-- CreateIndex
CREATE INDEX "workspace_uploads_workspace_id_created_by_status_idx" ON "workspace_uploads"("workspace_id", "created_by", "status");

-- CreateIndex
CREATE INDEX "workspace_drive_favorites_workspace_id_user_id_idx" ON "workspace_drive_favorites"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_drive_favorites_user_id_entity_entity_id_key" ON "workspace_drive_favorites"("user_id", "entity", "entity_id");

-- CreateIndex
CREATE INDEX "workspace_smart_folders_workspace_id_user_id_idx" ON "workspace_smart_folders"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "agent_run_folders_workspace_id_run_id_idx" ON "agent_run_folders"("workspace_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_folders_run_id_folder_path_key" ON "agent_run_folders"("run_id", "folder_path");

-- CreateIndex
CREATE INDEX "workspace_files_workspace_id_owner_user_id_idx" ON "workspace_files"("workspace_id", "owner_user_id");

-- AddForeignKey
ALTER TABLE "workspace_folders" ADD CONSTRAINT "workspace_folders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_folders" ADD CONSTRAINT "workspace_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "workspace_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_folder_acls" ADD CONSTRAINT "workspace_folder_acls_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_folder_acls" ADD CONSTRAINT "workspace_folder_acls_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "workspace_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_drive_cursors" ADD CONSTRAINT "workspace_drive_cursors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_drive_changes" ADD CONSTRAINT "workspace_drive_changes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_drive_quotas" ADD CONSTRAINT "workspace_drive_quotas_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_uploads" ADD CONSTRAINT "workspace_uploads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_drive_favorites" ADD CONSTRAINT "workspace_drive_favorites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_smart_folders" ADD CONSTRAINT "workspace_smart_folders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_folders" ADD CONSTRAINT "agent_run_folders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- Case/NFC-insensitive uniqueness among LIVE rows. Partial indexes cannot be
-- declared in schema.prisma; they are raw SQL like workspace_files_live_path_unique.
-- path_key is NULL on rows that pre-date Drive (not covered by the index).
-- ============================================================
CREATE UNIQUE INDEX "workspace_files_live_path_key_unique"
  ON "workspace_files"("workspace_id", "path_key")
  WHERE "trashed_at" IS NULL AND "path_key" IS NOT NULL;

CREATE UNIQUE INDEX "workspace_folders_live_path_key_unique"
  ON "workspace_folders"("workspace_id", "path_key")
  WHERE "trashed_at" IS NULL;

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17 migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_folders', 'workspace_folder_acls', 'workspace_drive_cursors',
    'workspace_drive_changes', 'workspace_drive_quotas', 'workspace_uploads',
    'workspace_drive_favorites', 'workspace_smart_folders', 'agent_run_folders'
  ] LOOP
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
