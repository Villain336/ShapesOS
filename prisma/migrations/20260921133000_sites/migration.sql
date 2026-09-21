-- Marketr milestone 7: Sites (landing pages & websites workstream).
-- A Site is the unit the AI builder creates and the IDE edits, regardless of
-- source: GitHub repo, SFTP host (via a milestone-6 SiteConnection), or a
-- managed file set (upload/AI-generated). Secrets live in config_enc
-- (AES-256-GCM, lib/sitefiles/crypto.ts) and are never exposed to the client.
CREATE TYPE "SiteSourceType" AS ENUM ('github', 'sftp', 'file');

CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source_type" "SiteSourceType" NOT NULL,
    "config_enc" TEXT NOT NULL,
    "sftp_connection_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "sites" ADD CONSTRAINT "sites_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sites" ADD CONSTRAINT "sites_sftp_connection_id_fkey" FOREIGN KEY ("sftp_connection_id") REFERENCES "site_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "sites_project_id_idx" ON "sites"("project_id");

-- Milestone 7: audit log entries can belong to a Site (IDE opened on a site)
-- instead of a raw connection.
ALTER TABLE "file_change_log" ADD COLUMN "site_id" TEXT;
ALTER TABLE "file_change_log" ADD CONSTRAINT "file_change_log_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
