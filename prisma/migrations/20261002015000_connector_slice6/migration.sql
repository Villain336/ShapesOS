-- Connector Agent slice 6: opt-in discoverability + Boardy escalation rail.
-- Pruned to slice-6 statements only (migrate dev is broken: pgcrypto
-- shadow-DB issue). Pre-existing drift untouched.
-- Idempotent: safe to re-run (enum/type/table/index/constraint guards).

-- CreateEnum: Boardy escalation request lifecycle
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConnectorBoardyRequestStatus') THEN CREATE TYPE "ConnectorBoardyRequestStatus" AS ENUM ('draft', 'approved', 'declined', 'sent', 'replied', 'cancelled'); END IF; END $$;

-- CreateTable: tenant-scoped opt-in directory profile (1 per workspace).
-- discoverable=false (default) = invisible to matching. Only published
-- facets are ever exposed across tenants; the private graph is never read
-- across tenants.
CREATE TABLE IF NOT EXISTS "connector_agent_directory_profiles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "discoverable" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "role" TEXT,
    "company" TEXT,
    "bio" TEXT,
    "industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "looking_for" TEXT,
    "share_name_role" BOOLEAN NOT NULL DEFAULT true,
    "share_full" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_agent_directory_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Boardy escalation requests (tenant-scoped, email rail)
CREATE TABLE IF NOT EXISTS "connector_agent_boardy_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "status" "ConnectorBoardyRequestStatus" NOT NULL DEFAULT 'draft',
    "target_name" TEXT NOT NULL,
    "target_role" TEXT,
    "target_context" TEXT NOT NULL,
    "offer_summary" TEXT NOT NULL,
    "drafted_subject" TEXT NOT NULL,
    "drafted_body" TEXT NOT NULL,
    "mode" "ConnectorMode" NOT NULL DEFAULT 'leads',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "sent_via" TEXT,
    "sent_at" TIMESTAMP(3),
    "priority_thread" BOOLEAN NOT NULL DEFAULT false,
    "reply_summary" TEXT,
    "replied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_agent_boardy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable: audit lineage per Boardy request
CREATE TABLE IF NOT EXISTS "connector_agent_boardy_request_events" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_identity" TEXT NOT NULL,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_agent_boardy_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "connector_agent_directory_profiles_workspace_id_key" ON "connector_agent_directory_profiles"("workspace_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "connector_agent_boardy_requests_workspace_id_idx" ON "connector_agent_boardy_requests"("workspace_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "connector_agent_boardy_requests_workspace_id_status_idx" ON "connector_agent_boardy_requests"("workspace_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "connector_agent_boardy_request_events_request_id_created_at_idx" ON "connector_agent_boardy_request_events"("request_id", "created_at");

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_directory_profiles_workspace_id_fkey') THEN ALTER TABLE "connector_agent_directory_profiles" ADD CONSTRAINT "connector_agent_directory_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_boardy_requests_workspace_id_fkey') THEN ALTER TABLE "connector_agent_boardy_requests" ADD CONSTRAINT "connector_agent_boardy_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connector_agent_boardy_request_events_request_id_fkey') THEN ALTER TABLE "connector_agent_boardy_request_events" ADD CONSTRAINT "connector_agent_boardy_request_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "connector_agent_boardy_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;
