-- Marketr milestone 9: hosting deploy targets (Vercel + Cloudflare Pages).
-- HostingConnection stores encrypted API tokens (AES-256-GCM) per project;
-- Deployment records each deploy of a site's working copy with URL + status.
CREATE TYPE "DeployTargetType" AS ENUM ('vercel', 'cloudflare-pages');

CREATE TABLE "hosting_connections" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" "DeployTargetType" NOT NULL,
    "config_enc" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hosting_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "target" "DeployTargetType" NOT NULL,
    "url" TEXT,
    "deployment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deployments_site_id_created_at_idx" ON "deployments"("site_id", "created_at");

ALTER TABLE "hosting_connections" ADD CONSTRAINT "hosting_connections_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deployments" ADD CONSTRAINT "deployments_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deployments" ADD CONSTRAINT "deployments_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "hosting_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Extend the change audit log with a deploy action (milestone 9).
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'deploy';
