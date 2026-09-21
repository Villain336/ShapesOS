-- Marketr milestone 6: site (SFTP/SSH) connections + IDE change audit log.
-- Credentials are AES-256-GCM encrypted at rest (see lib/sitefiles/crypto.ts)
-- and are never exposed to the client.
CREATE TYPE "SiteAuthType" AS ENUM ('password', 'key');
CREATE TYPE "FileChangeActor" AS ENUM ('user', 'ai');
CREATE TYPE "FileChangeAction" AS ENUM ('save', 'ai_proposal', 'ai_applied');

CREATE TABLE "site_connections" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "auth_type" "SiteAuthType" NOT NULL DEFAULT 'password',
    "secret_enc" TEXT NOT NULL,
    "secret_hint" TEXT,
    "demo" BOOLEAN NOT NULL DEFAULT false,
    "last_tested_at" TIMESTAMP(3),
    "last_test_ok" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_connections_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "site_connections" ADD CONSTRAINT "site_connections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "file_change_log" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "file_path" TEXT NOT NULL,
    "actor" "FileChangeActor" NOT NULL,
    "action" "FileChangeAction" NOT NULL,
    "summary" TEXT NOT NULL,
    "approved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_change_log_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "file_change_log" ADD CONSTRAINT "file_change_log_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "file_change_log_project_id_created_at_idx" ON "file_change_log"("project_id", "created_at");
