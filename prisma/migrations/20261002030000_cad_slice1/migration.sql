-- CAD + Hardware slice 1: CAD viewer + versioning.
-- Hand-pruned from `prisma migrate diff` output (migrate dev is broken on
-- this box: the pgserver-bundled PG lacks pgcrypto contrib files for the
-- shadow DB — see the infra note in workspace PROGRESS files). Applied via
-- psql, then `prisma migrate resolve --applied`. Pre-existing schema↔DB
-- drift from earlier slices (wfh_*, regulation_changes, legal_radar_triage,
-- mission_plane_links, …) deliberately NOT touched here.
--
-- Idempotent: IF NOT EXISTS / DO-block guards throughout, so a re-apply is
-- a no-op.

-- Enum
DO $$
BEGIN
  CREATE TYPE "CadModelFormat" AS ENUM ('stl', 'obj', 'step');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Tables
CREATE TABLE IF NOT EXISTS "cad_projects" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cad_projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cad_models" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by" TEXT,
    "current_version_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cad_models_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cad_model_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "workspace_file_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "format" "CadModelFormat" NOT NULL,
    "triangle_count" INTEGER,
    "bbox_min" JSONB,
    "bbox_max" JSONB,
    "volume_estimate" DOUBLE PRECISION,
    "preview_available" BOOLEAN NOT NULL,
    "notes" TEXT,
    "uploaded_by" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedes_version_id" TEXT,

    CONSTRAINT "cad_model_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cad_model_diffs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "from_version_id" TEXT NOT NULL,
    "to_version_id" TEXT NOT NULL,
    "availability" TEXT NOT NULL,
    "triangle_delta" INTEGER,
    "size_delta" JSONB,
    "center_delta" DOUBLE PRECISION,
    "volume_from" DOUBLE PRECISION,
    "volume_to" DOUBLE PRECISION,
    "volume_delta" DOUBLE PRECISION,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_model_diffs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "cad_share_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "pinned_version_id" TEXT,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_share_links_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "cad_projects_workspace_id_idx" ON "cad_projects"("workspace_id");
CREATE INDEX IF NOT EXISTS "cad_models_workspace_id_project_id_idx" ON "cad_models"("workspace_id", "project_id");
CREATE INDEX IF NOT EXISTS "cad_model_versions_workspace_file_id_idx" ON "cad_model_versions"("workspace_file_id");
CREATE UNIQUE INDEX IF NOT EXISTS "cad_model_versions_model_id_version_number_key" ON "cad_model_versions"("model_id", "version_number");
CREATE UNIQUE INDEX IF NOT EXISTS "cad_model_diffs_model_id_from_version_id_to_version_id_key" ON "cad_model_diffs"("model_id", "from_version_id", "to_version_id");
CREATE UNIQUE INDEX IF NOT EXISTS "cad_share_links_token_key" ON "cad_share_links"("token");
CREATE INDEX IF NOT EXISTS "cad_share_links_workspace_id_model_id_idx" ON "cad_share_links"("workspace_id", "model_id");

-- Foreign keys
DO $$
BEGIN
  ALTER TABLE "cad_projects" ADD CONSTRAINT "cad_projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_models" ADD CONSTRAINT "cad_models_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_models" ADD CONSTRAINT "cad_models_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "cad_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_models" ADD CONSTRAINT "cad_models_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "cad_model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_model_versions" ADD CONSTRAINT "cad_model_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_model_versions" ADD CONSTRAINT "cad_model_versions_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "cad_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_model_versions" ADD CONSTRAINT "cad_model_versions_workspace_file_id_fkey" FOREIGN KEY ("workspace_file_id") REFERENCES "workspace_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_model_versions" ADD CONSTRAINT "cad_model_versions_supersedes_version_id_fkey" FOREIGN KEY ("supersedes_version_id") REFERENCES "cad_model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_model_diffs" ADD CONSTRAINT "cad_model_diffs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_model_diffs" ADD CONSTRAINT "cad_model_diffs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "cad_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_model_diffs" ADD CONSTRAINT "cad_model_diffs_from_version_id_fkey" FOREIGN KEY ("from_version_id") REFERENCES "cad_model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_model_diffs" ADD CONSTRAINT "cad_model_diffs_to_version_id_fkey" FOREIGN KEY ("to_version_id") REFERENCES "cad_model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_share_links" ADD CONSTRAINT "cad_share_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_share_links" ADD CONSTRAINT "cad_share_links_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "cad_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "cad_share_links" ADD CONSTRAINT "cad_share_links_pinned_version_id_fkey" FOREIGN KEY ("pinned_version_id") REFERENCES "cad_model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
