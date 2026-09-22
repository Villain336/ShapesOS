-- Marketr milestone 22: Canva Connect studio + Porkbun domains.
-- HAND-WRITTEN, NOT APPLIED — review before `prisma migrate deploy` (no PostgreSQL in the sandbox).

-- Extend the audit action enum (PostgreSQL enum — add values; safe, no rewrite).
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_canva_connected';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_canva_disconnected';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_canva_failed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_canva_refreshed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_canva_exported';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_canva_autofilled';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_asset_created';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_asset_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_porkbun_keys_updated';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_registrant_saved';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_domain_purchased';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_domain_purchase_failed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'studio_domain_removed';

CREATE TABLE "studio_canva_accounts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL UNIQUE,
  "canva_user_id" TEXT,
  "access_token_enc" TEXT NOT NULL,
  "refresh_token_enc" TEXT NOT NULL,
  "token_expires_at" TIMESTAMPTZ NOT NULL,
  "scopes" TEXT NOT NULL DEFAULT '',
  "connected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "studio_canva_accounts_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "studio_porkbun_settings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL UNIQUE,
  "api_key_enc" TEXT NOT NULL,
  "secret_key_enc" TEXT NOT NULL,
  "api_key_hint" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "studio_porkbun_settings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "studio_registrants" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL UNIQUE,
  "first_name" TEXT NOT NULL,
  "last_name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT '',
  "zip" TEXT NOT NULL,
  "country" TEXT NOT NULL DEFAULT 'US',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "studio_registrants_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "studio_domains" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "project_id" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "tld" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "price_usd" DECIMAL(10,2),
  "order_id" TEXT,
  "whois_privacy" BOOLEAN NOT NULL DEFAULT true,
  "purchased_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ,
  "name_servers" TEXT,
  "error_detail" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "studio_domains_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "studio_domains_project_id_domain_key" UNIQUE ("project_id", "domain")
);

CREATE TABLE "project_assets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "project_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "mime_type" TEXT,
  "metadata" TEXT,
  "canva_design_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_assets_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "project_assets_project_id_source_idx" ON "project_assets"("project_id", "source");
