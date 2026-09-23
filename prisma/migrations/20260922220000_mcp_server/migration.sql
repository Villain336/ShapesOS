-- Phase C (W5): Marketr as MCP server (spec §7 W5).
-- HAND-WRITTEN — review before first real deploy.
-- All statements idempotent: safe to re-run.

-- Workspace opt-in flag (OFF by default — new attack surface requires opt-in)
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "mcp_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Audit actions used by the MCP server (idempotent)
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'mcp_tool_called';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'mcp_tool_denied';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'mcp_key_created';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'mcp_key_revoked';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'mcp_oauth_authorized';

-- Workspace API keys (SHA-256 hash stored; raw key NEVER stored)
CREATE TABLE IF NOT EXISTS "mcp_api_keys" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "key_prefix" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "expires_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mcp_api_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_api_keys_key_hash_key" ON "mcp_api_keys"("key_hash");
CREATE INDEX IF NOT EXISTS "mcp_api_keys_workspace_id_idx" ON "mcp_api_keys"("workspace_id");

-- OAuth 2.1 Dynamic Client Registration (RFC 7591) clients
CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
  "client_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "workspace_id" TEXT,
  "client_name" TEXT,
  "redirect_uris" TEXT[] NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("client_id")
);

-- Single-use authorization codes (PKCE S256)
CREATE TABLE IF NOT EXISTS "mcp_oauth_codes" (
  "code" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "redirect_uri" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "code_challenge" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mcp_oauth_codes_pkey" PRIMARY KEY ("code")
);
CREATE INDEX IF NOT EXISTS "mcp_oauth_codes_client_id_idx" ON "mcp_oauth_codes"("client_id");

-- Access tokens (SHA-256 hash stored; raw token NEVER stored)
CREATE TABLE IF NOT EXISTS "mcp_oauth_tokens" (
  "token_hash" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mcp_oauth_tokens_pkey" PRIMARY KEY ("token_hash")
);
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_workspace_id_idx" ON "mcp_oauth_tokens"("workspace_id");
