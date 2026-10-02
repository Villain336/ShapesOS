
-- AlterTable
ALTER TABLE "funding_data_room_docs" ADD COLUMN     "current_version_id" TEXT;

-- CreateTable
CREATE TABLE "funding_data_room_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "workspace_file_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedes_version_id" TEXT,

    CONSTRAINT "funding_data_room_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_share_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "doc_id" TEXT,
    "doc_version_id" TEXT,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "viewer_emails" TEXT[],
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funding_share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_doc_views" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "doc_version_id" TEXT,
    "viewer_identity" TEXT NOT NULL,
    "user_agent" TEXT,
    "duration_ms" INTEGER,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_doc_views_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "funding_data_room_versions_workspace_file_id_idx" ON "funding_data_room_versions"("workspace_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "funding_data_room_versions_document_id_version_number_key" ON "funding_data_room_versions"("document_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "funding_share_links_token_key" ON "funding_share_links"("token");

-- CreateIndex
CREATE INDEX "funding_share_links_workspace_id_revoked_idx" ON "funding_share_links"("workspace_id", "revoked");

-- CreateIndex
CREATE INDEX "funding_doc_views_workspace_id_opened_at_idx" ON "funding_doc_views"("workspace_id", "opened_at");

-- CreateIndex
CREATE INDEX "funding_doc_views_link_id_opened_at_idx" ON "funding_doc_views"("link_id", "opened_at");

-- AddForeignKey
ALTER TABLE "funding_data_room_docs" ADD CONSTRAINT "funding_data_room_docs_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "funding_data_room_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_data_room_versions" ADD CONSTRAINT "funding_data_room_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_data_room_versions" ADD CONSTRAINT "funding_data_room_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "funding_data_room_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_data_room_versions" ADD CONSTRAINT "funding_data_room_versions_workspace_file_id_fkey" FOREIGN KEY ("workspace_file_id") REFERENCES "workspace_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_data_room_versions" ADD CONSTRAINT "funding_data_room_versions_supersedes_version_id_fkey" FOREIGN KEY ("supersedes_version_id") REFERENCES "funding_data_room_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_share_links" ADD CONSTRAINT "funding_share_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_share_links" ADD CONSTRAINT "funding_share_links_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "funding_data_room_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_share_links" ADD CONSTRAINT "funding_share_links_doc_version_id_fkey" FOREIGN KEY ("doc_version_id") REFERENCES "funding_data_room_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_doc_views" ADD CONSTRAINT "funding_doc_views_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_doc_views" ADD CONSTRAINT "funding_doc_views_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "funding_share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_doc_views" ADD CONSTRAINT "funding_doc_views_doc_version_id_fkey" FOREIGN KEY ("doc_version_id") REFERENCES "funding_data_room_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
