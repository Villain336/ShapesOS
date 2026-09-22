-- Milestone 21: user-installable skills, connectors, workspace/project settings.
-- HAND-WRITTEN (no Postgres in sandbox) — review before first real deploy.
-- Enum additions are idempotent (ADD VALUE IF NOT EXISTS).

ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'skill_installed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'skill_enabled';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'skill_disabled';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'skill_uninstalled';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'connector_connected';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'connector_disconnected';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'connector_reauth';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'mcp_connector_added';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'mcp_connector_removed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'data_source_bound';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'data_source_unbound';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'file_attached';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'file_removed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'settings_workspace_updated';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'settings_project_updated';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'permission_grant_created';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'permission_grant_removed';

-- New enums
DO $$ BEGIN
  CREATE TYPE "SkillSource" AS ENUM ('registry', 'url', 'upload');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SkillTrustTier" AS ENUM ('built_in', 'pinned_url');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ConnectorKind" AS ENUM ('native', 'mcp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ConnectorAuthType" AS ENUM ('oauth2', 'api_key', 'none');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ConnectionStatus" AS ENUM ('active', 'needs_reauth', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- skills
CREATE TABLE IF NOT EXISTS "skills" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "source" "SkillSource" NOT NULL,
  "source_ref" TEXT,
  "version" TEXT NOT NULL DEFAULT '1.0.0',
  "sha_pin" TEXT,
  "skill_md" TEXT NOT NULL,
  "declared_tools" TEXT[] NOT NULL DEFAULT '{}',
  "trust_tier" "SkillTrustTier" NOT NULL,
  "installed_by" TEXT,
  "installed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("workspace_id", "slug")
);
CREATE INDEX IF NOT EXISTS "skills_workspace_id_idx" ON "skills"("workspace_id");

-- project_skills
CREATE TABLE IF NOT EXISTS "project_skills" (
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "skill_id" TEXT NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "enabled_by" TEXT,
  "enabled_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("project_id", "skill_id")
);

-- connectors (workspace-custom MCP servers only; built-ins live in code)
CREATE TABLE IF NOT EXISTS "connectors" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "key" TEXT NOT NULL,
  "kind" "ConnectorKind" NOT NULL DEFAULT 'mcp',
  "display_name" TEXT NOT NULL,
  "auth_type" "ConnectorAuthType" NOT NULL DEFAULT 'none',
  "config" JSONB,
  "mcp_endpoint" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("workspace_id", "key")
);
CREATE INDEX IF NOT EXISTS "connectors_workspace_id_idx" ON "connectors"("workspace_id");

-- connector_connections
CREATE TABLE IF NOT EXISTS "connector_connections" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "connector_key" TEXT NOT NULL,
  "connector_id" TEXT REFERENCES "connectors"("id") ON DELETE CASCADE,
  "workspace_id" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL,
  "status" "ConnectionStatus" NOT NULL DEFAULT 'active',
  "scopes" TEXT[] NOT NULL DEFAULT '{}',
  "meta" JSONB,
  "connected_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_refresh_at" TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "connector_connections_workspace_id_idx" ON "connector_connections"("workspace_id");
CREATE INDEX IF NOT EXISTS "connector_connections_user_id_idx" ON "connector_connections"("user_id");
CREATE INDEX IF NOT EXISTS "connector_connections_connector_key_idx" ON "connector_connections"("connector_key");

-- connector_credentials
CREATE TABLE IF NOT EXISTS "connector_credentials" (
  "connection_id" TEXT NOT NULL PRIMARY KEY REFERENCES "connector_connections"("id") ON DELETE CASCADE,
  "encrypted_blob" TEXT NOT NULL,
  "key_version" TEXT NOT NULL DEFAULT 'env-v1',
  "expires_at" TIMESTAMPTZ,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- project_data_sources
CREATE TABLE IF NOT EXISTS "project_data_sources" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "connection_id" TEXT NOT NULL REFERENCES "connector_connections"("id") ON DELETE CASCADE,
  "connector_key" TEXT NOT NULL,
  "project_config" JSONB,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("project_id", "connection_id")
);
CREATE INDEX IF NOT EXISTS "project_data_sources_project_id_idx" ON "project_data_sources"("project_id");

-- file_attachments
CREATE TABLE IF NOT EXISTS "file_attachments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "session_id" TEXT,
  "source" TEXT NOT NULL,
  "connector_key" TEXT,
  "external_ref" TEXT,
  "filename" TEXT NOT NULL,
  "mime_type" TEXT,
  "size_bytes" INTEGER,
  "storage_path" TEXT,
  "uploaded_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "file_attachments_project_id_idx" ON "file_attachments"("project_id");
CREATE INDEX IF NOT EXISTS "file_attachments_session_id_idx" ON "file_attachments"("session_id");

-- workspace_settings
CREATE TABLE IF NOT EXISTS "workspace_settings" (
  "workspace_id" TEXT NOT NULL PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "default_model" TEXT,
  "default_approval_mode" TEXT NOT NULL DEFAULT 'supervised',
  "notification_defaults" JSONB,
  "data_governance" JSONB,
  "agent_allow_list" TEXT[] NOT NULL DEFAULT '{}',
  "updated_by" TEXT,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- project_settings
CREATE TABLE IF NOT EXISTS "project_settings" (
  "project_id" TEXT NOT NULL PRIMARY KEY REFERENCES "projects"("id") ON DELETE CASCADE,
  "overrides" JSONB,
  "brand_context" TEXT,
  "domains" TEXT[] NOT NULL DEFAULT '{}',
  "approval_mode_override" TEXT,
  "publishing_controls" JSONB,
  "updated_by" TEXT,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- permission_grants
CREATE TABLE IF NOT EXISTS "permission_grants" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" TEXT,
  "role" "WorkspaceRole",
  "permission" TEXT NOT NULL,
  "granted_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "permission_grants_target_check" CHECK ("user_id" IS NOT NULL OR "role" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "permission_grants_workspace_id_user_id_idx" ON "permission_grants"("workspace_id", "user_id");
