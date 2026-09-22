-- Phase B (W3, track B1): private workspace filesystem registry.
-- Idempotent per M21 convention: safe to apply more than once.

-- Enum (lowercase values per repo convention).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkspaceFileKind') THEN
    CREATE TYPE "WorkspaceFileKind" AS ENUM ('skill', 'memory', 'artifact', 'file');
  END IF;
END
$$;

-- Registry table: the authorization boundary for the filesystem.
CREATE TABLE IF NOT EXISTS "workspace_files" (
  "id"           TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "logical_path" TEXT NOT NULL,
  "storage_key"  TEXT NOT NULL,
  "filename"     VARCHAR(255) NOT NULL,
  "mime_type"    TEXT NOT NULL,
  "size_bytes"   INTEGER NOT NULL,
  "kind"         "WorkspaceFileKind" NOT NULL,
  "created_by"   TEXT NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "trashed_at"   TIMESTAMP(3),

  CONSTRAINT "workspace_files_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_files_storage_key_key" UNIQUE ("storage_key"),
  CONSTRAINT "workspace_files_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "workspace_files_workspace_id_trashed_at_idx"
  ON "workspace_files"("workspace_id", "trashed_at");
CREATE INDEX IF NOT EXISTS "workspace_files_workspace_id_kind_idx"
  ON "workspace_files"("workspace_id", "kind");

-- Live (non-trashed) logical paths are unique per workspace. Trashed rows
-- are exempt so a trashed file never blocks re-upload or restore resolution.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'workspace_files_live_path_unique'
  ) THEN
    CREATE UNIQUE INDEX "workspace_files_live_path_unique"
      ON "workspace_files"("workspace_id", "logical_path")
      WHERE "trashed_at" IS NULL;
  END IF;
END
$$;

-- Per-workspace quota. Row is created eagerly (default 10 GB) so quota
-- checks can take a row lock and serialize concurrent writers.
CREATE TABLE IF NOT EXISTS "workspace_quotas" (
  "workspace_id" TEXT NOT NULL,
  "limit_bytes"  BIGINT NOT NULL,
  "used_bytes"   BIGINT NOT NULL DEFAULT 0,

  CONSTRAINT "workspace_quotas_pkey" PRIMARY KEY ("workspace_id"),
  CONSTRAINT "workspace_quotas_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
