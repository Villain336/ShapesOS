-- ShapesOS Phase 18.2 (WS=content): Notes (UniverDoc kind "note" + links),
-- document version history and live-collaboration state, Files versions /
-- share links / per-file access / PDF annotations, terminal sessions, and
-- the Store's per-workspace state and agency publications.
-- Every new table: workspace_id, ON DELETE CASCADE from workspaces, FORCE
-- RLS on app.workspace_id (fail-closed without the GUC). Two exceptions,
-- both narrow: the public file share route resolves a link by its
-- token hash (SELECT-only, app.file_share_route = 'lookup'), and a store
-- publication is visible to both the client (workspace_id) and the agency
-- that sent it (agency_workspace_id = app.workspace_id).

-- AlterTable
ALTER TABLE "workspace_files" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "workspace_quotas" ADD COLUMN     "version_retention" INTEGER NOT NULL DEFAULT 20;

-- AlterTable
ALTER TABLE "univer_docs" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "folder" VARCHAR(120),
ADD COLUMN     "pinned_at" TIMESTAMP(3),
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "note_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "record_kind" VARCHAR(40) NOT NULL,
    "record_id" VARCHAR(64) NOT NULL,
    "label" VARCHAR(200),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "univer_doc_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "doc_version" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "name" VARCHAR(120),
    "title" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "univer_doc_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "univer_doc_collab_states" (
    "doc_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "state" BYTEA NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "univer_doc_collab_states_pkey" PRIMARY KEY ("doc_id")
);

-- CreateTable
CREATE TABLE "workspace_file_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "replaced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replaced_by" TEXT NOT NULL,

    CONSTRAINT "workspace_file_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_file_shares" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_hint" VARCHAR(8) NOT NULL,
    "access" VARCHAR(16) NOT NULL DEFAULT 'view',
    "password_hash" TEXT,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "last_opened_at" TIMESTAMP(3),

    CONSTRAINT "workspace_file_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_file_acls" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" VARCHAR(16) NOT NULL,
    "granted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_file_acls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_file_annotations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "file_version" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "rects" JSONB NOT NULL,
    "quote" TEXT,
    "body" TEXT,
    "author_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_file_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "sandbox_id" TEXT NOT NULL,
    "secret_enc" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "ended_reason" TEXT,

    CONSTRAINT "terminal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_commands" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "exit_code" INTEGER,
    "timed_out" BOOLEAN NOT NULL DEFAULT false,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terminal_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_store_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "item_key" VARCHAR(120) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'builtin',
    "publication_id" TEXT,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_store_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_publications" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "agency_workspace_id" TEXT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "item_key" VARCHAR(120) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "published_by" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "note_links_workspace_id_record_kind_record_id_idx" ON "note_links"("workspace_id", "record_kind", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "note_links_doc_id_record_kind_record_id_key" ON "note_links"("doc_id", "record_kind", "record_id");

-- CreateIndex
CREATE INDEX "univer_doc_versions_workspace_id_doc_id_created_at_idx" ON "univer_doc_versions"("workspace_id", "doc_id", "created_at");

-- CreateIndex
CREATE INDEX "univer_doc_collab_states_workspace_id_idx" ON "univer_doc_collab_states"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_file_versions_storage_key_key" ON "workspace_file_versions"("storage_key");

-- CreateIndex
CREATE INDEX "workspace_file_versions_workspace_id_file_id_idx" ON "workspace_file_versions"("workspace_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_file_versions_file_id_version_key" ON "workspace_file_versions"("file_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_file_shares_token_hash_key" ON "workspace_file_shares"("token_hash");

-- CreateIndex
CREATE INDEX "workspace_file_shares_workspace_id_file_id_idx" ON "workspace_file_shares"("workspace_id", "file_id");

-- CreateIndex
CREATE INDEX "workspace_file_acls_workspace_id_user_id_idx" ON "workspace_file_acls"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_file_acls_file_id_user_id_key" ON "workspace_file_acls"("file_id", "user_id");

-- CreateIndex
CREATE INDEX "workspace_file_annotations_workspace_id_file_id_file_versio_idx" ON "workspace_file_annotations"("workspace_id", "file_id", "file_version");

-- CreateIndex
CREATE INDEX "terminal_sessions_workspace_id_status_idx" ON "terminal_sessions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "terminal_sessions_workspace_id_user_id_started_at_idx" ON "terminal_sessions"("workspace_id", "user_id", "started_at");

-- CreateIndex
CREATE INDEX "terminal_commands_workspace_id_session_id_created_at_idx" ON "terminal_commands"("workspace_id", "session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_store_items_workspace_id_kind_item_key_key" ON "workspace_store_items"("workspace_id", "kind", "item_key");

-- CreateIndex
CREATE INDEX "store_publications_workspace_id_status_idx" ON "store_publications"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "store_publications_agency_workspace_id_created_at_idx" ON "store_publications"("agency_workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "univer_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "univer_doc_versions" ADD CONSTRAINT "univer_doc_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "univer_doc_versions" ADD CONSTRAINT "univer_doc_versions_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "univer_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "univer_doc_collab_states" ADD CONSTRAINT "univer_doc_collab_states_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "univer_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "univer_doc_collab_states" ADD CONSTRAINT "univer_doc_collab_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_file_versions" ADD CONSTRAINT "workspace_file_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_file_versions" ADD CONSTRAINT "workspace_file_versions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "workspace_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_file_shares" ADD CONSTRAINT "workspace_file_shares_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_file_shares" ADD CONSTRAINT "workspace_file_shares_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "workspace_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_file_acls" ADD CONSTRAINT "workspace_file_acls_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_file_acls" ADD CONSTRAINT "workspace_file_acls_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "workspace_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_file_annotations" ADD CONSTRAINT "workspace_file_annotations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_file_annotations" ADD CONSTRAINT "workspace_file_annotations_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "workspace_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_commands" ADD CONSTRAINT "terminal_commands_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_commands" ADD CONSTRAINT "terminal_commands_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "terminal_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_store_items" ADD CONSTRAINT "workspace_store_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_publications" ADD CONSTRAINT "store_publications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_publications" ADD CONSTRAINT "store_publications_agency_workspace_id_fkey" FOREIGN KEY ("agency_workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: tenant isolation on app.workspace_id. ENABLE + FORCE; sessions
-- without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'note_links', 'univer_doc_versions', 'univer_doc_collab_states',
    'workspace_file_versions', 'workspace_file_shares', 'workspace_file_acls',
    'workspace_file_annotations', 'terminal_sessions', 'terminal_commands',
    'workspace_store_items'
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

-- Public file share links (lib/files/shares.ts resolveShareToken): the one
-- cross-workspace read, by token hash, live (unrevoked) links only; every
-- read and write after it runs under the link's own workspace scope.
CREATE POLICY workspace_file_shares_public_route ON "workspace_file_shares" FOR SELECT
  USING (current_setting('app.file_share_route', true) = 'lookup' AND "revoked_at" IS NULL);

-- Store publications: the client workspace (workspace_id) decides; the
-- agency that sent it (agency_workspace_id) lists and revokes it.
ALTER TABLE "store_publications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_publications" FORCE ROW LEVEL SECURITY;
CREATE POLICY store_publications_party_isolation ON "store_publications" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true)
      OR agency_workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)
      OR agency_workspace_id = current_setting('app.workspace_id', true));
