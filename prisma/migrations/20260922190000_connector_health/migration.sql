-- Phase B (B3): cached connector health (spec W2.5, §7 ConnectorHealth).
-- HAND-WRITTEN (no Postgres in sandbox) — review before first real deploy.
-- All statements idempotent: safe to re-run.

-- New enum (idempotent)
DO $$ BEGIN
  CREATE TYPE "ConnectorHealthStatus" AS ENUM ('healthy', 'degraded', 'needs_reauth', 'error', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Audit actions used by the health checker (idempotent)
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'connector_health_checked';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'connector_health_alert';

-- Health cache table (idempotent)
CREATE TABLE IF NOT EXISTS "connector_health" (
  "id" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "status" "ConnectorHealthStatus" NOT NULL DEFAULT 'unknown',
  "last_check_at" TIMESTAMP(3) NOT NULL,
  "last_success_at" TIMESTAMP(3),
  "last_error" TEXT,
  "quota_used" DOUBLE PRECISION,
  "quota_limit" DOUBLE PRECISION,
  "last_alert_at" TIMESTAMP(3),
  "consecutive_errors" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "connector_health_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "connector_health_connection_id_key" ON "connector_health"("connection_id");
CREATE INDEX IF NOT EXISTS "connector_health_workspace_id_idx" ON "connector_health"("workspace_id");
DO $$ BEGIN
  ALTER TABLE "connector_health"
    ADD CONSTRAINT "connector_health_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "connector_connections"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
