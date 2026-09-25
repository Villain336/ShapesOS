-- Marketr — Phase 8 G1: Business Graph substrate (SPEC-PHASE8.md §2 G1, §4).
--
-- Postgres-native graph: append-only graph_facts log, resolved graph_nodes,
-- bi-temporal graph_edges (Graphiti-style), human-gated graph_er_queue,
-- graph_connectors hub + graph_sync_jobs bookkeeping.
--
-- Tenant isolation: RLS from day one (spec §9.2). Every table carries
-- workspace_id with FORCE ROW LEVEL SECURITY; the tenant principal is the
-- `app.workspace_id` GUC, set per-transaction by
-- lib/substrate/graph/rls.ts `withWorkspaceScope()`. Sessions that do NOT
-- set the GUC see zero rows (fail-closed) — this includes the table owner,
-- because FORCE is enabled. Migration/deploy tooling must SET
-- app.workspace_id before touching these tables.
--
-- Extensions: pg_trgm (fuzzy ER blocking, required) + pgvector (reserved
-- for the G1 embedding-blocking upgrade path; G3 recall uses it). pg_trgm
-- is a trusted extension and creates as the app role. pgvector needs
-- superuser; nothing in v1 uses a vector column, so if the deploying role
-- lacks the privilege we NOTICE and continue — the G1 graph is fully
-- functional without it. (Install pgvector + re-run CREATE EXTENSION
-- vector as a superuser before enabling embedding blocking.)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pgvector not installed (needs superuser): embedding-blocking upgrade path disabled until a superuser runs CREATE EXTENSION vector';
END $$;

-- Enums (match Prisma native enum names)
CREATE TYPE "GraphEntityType" AS ENUM (
  'customer','competitor','product','service','price','brand','employee',
  'location','campaign_ref','review','website','crm_record','creative_asset',
  'keyword','content','channel','offer','audience','landing_page','form_cta'
);
CREATE TYPE "GraphErStatus" AS ENUM ('pending','approved','rejected');
CREATE TYPE "GraphConnectorPlatform" AS ENUM (
  'hubspot','salesforce','shopify','woocommerce','google_ads','meta','tiktok','linkedin'
);
CREATE TYPE "GraphConnectorStatus" AS ENUM ('connected','pending','error','revoked');
CREATE TYPE "GraphSyncTier" AS ENUM ('webhook','scheduled','manual');
CREATE TYPE "GraphSyncJobStatus" AS ENUM ('idle','running','succeeded','failed','backing_off','dead');

-- Append-only fact log: no UPDATE/DELETE in application code (spec §9.4).
CREATE TABLE "graph_facts" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_record_id" TEXT NOT NULL,
  "entity_ref" TEXT NOT NULL,
  "fact_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "content_hash" TEXT NOT NULL,
  CONSTRAINT "graph_facts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "graph_facts_workspace_id_source_source_record_id_fa_key"
  ON "graph_facts"("workspace_id","source","source_record_id","fact_type","content_hash");
CREATE INDEX "graph_facts_workspace_id_entity_ref_idx" ON "graph_facts"("workspace_id","entity_ref");
CREATE INDEX "graph_facts_workspace_id_fact_type_idx" ON "graph_facts"("workspace_id","fact_type");
CREATE INDEX "graph_facts_workspace_id_ingested_at_idx" ON "graph_facts"("workspace_id","ingested_at");

-- Resolved current state.
CREATE TABLE "graph_nodes" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "entity_type" "GraphEntityType" NOT NULL,
  "canonical_key" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "core" JSONB NOT NULL DEFAULT '{}',
  "properties" JSONB NOT NULL DEFAULT '{}',
  "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "as_of" TIMESTAMPTZ(6) NOT NULL,
  "as_of_source" TEXT NOT NULL,
  "merged_into_id" TEXT,
  CONSTRAINT "graph_nodes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "graph_nodes_workspace_id_canonical_key_key"
  ON "graph_nodes"("workspace_id","canonical_key");
CREATE INDEX "graph_nodes_workspace_id_entity_type_idx" ON "graph_nodes"("workspace_id","entity_type");
CREATE INDEX "graph_nodes_workspace_id_merged_into_id_idx" ON "graph_nodes"("workspace_id","merged_into_id");
-- trigram index for fuzzy ER blocking on display names
CREATE INDEX "graph_nodes_display_name_trgm_idx" ON "graph_nodes" USING gin ("display_name" gin_trgm_ops);

-- Bi-temporal edges. Rows are invalidated, never deleted.
CREATE TABLE "graph_edges" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "from_node_id" TEXT NOT NULL,
  "to_node_id" TEXT NOT NULL,
  "edge_type" TEXT NOT NULL,
  "properties" JSONB NOT NULL DEFAULT '{}',
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "valid_at" TIMESTAMPTZ(6) NOT NULL,
  "invalid_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expired_at" TIMESTAMPTZ(6),
  "source_fact_id" TEXT,
  "superseded_by_id" TEXT,
  CONSTRAINT "graph_edges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "graph_edges_workspace_id_from_node_id_edge_type_idx"
  ON "graph_edges"("workspace_id","from_node_id","edge_type");
CREATE INDEX "graph_edges_workspace_id_to_node_id_edge_type_idx"
  ON "graph_edges"("workspace_id","to_node_id","edge_type");
CREATE INDEX "graph_edges_workspace_id_edge_type_valid_at_idx"
  ON "graph_edges"("workspace_id","edge_type","valid_at");

-- Human ER review queue (v1: no auto-merge — spec §9.6).
CREATE TABLE "graph_er_queue" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "node_a_id" TEXT NOT NULL,
  "node_b_id" TEXT NOT NULL,
  "matcher_signals" JSONB NOT NULL DEFAULT '[]',
  "confidence" DOUBLE PRECISION NOT NULL,
  "status" "GraphErStatus" NOT NULL DEFAULT 'pending',
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "graph_er_queue_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "graph_er_queue_workspace_id_status_idx" ON "graph_er_queue"("workspace_id","status");

-- Connector hub. auth_ref / webhook_secret_ref are VAULT REFERENCE IDS —
-- never secrets (spec §9.9).
CREATE TABLE "graph_connectors" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "platform" "GraphConnectorPlatform" NOT NULL,
  "auth_ref" TEXT,
  "tier" "GraphSyncTier" NOT NULL,
  "status" "GraphConnectorStatus" NOT NULL DEFAULT 'pending',
  "scopes_granted" TEXT[] NOT NULL DEFAULT '{}',
  "webhook_secret_ref" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "graph_connectors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "graph_connectors_workspace_id_platform_key"
  ON "graph_connectors"("workspace_id","platform");

-- Sync-job bookkeeping.
CREATE TABLE "graph_sync_jobs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "connector_id" TEXT NOT NULL,
  "tier" "GraphSyncTier" NOT NULL,
  "schedule_cron" TEXT,
  "cursor_state" JSONB NOT NULL DEFAULT '{}',
  "rate_budget" JSONB NOT NULL DEFAULT '{}',
  "last_run_at" TIMESTAMPTZ(6),
  "last_success_at" TIMESTAMPTZ(6),
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "backoff_until" TIMESTAMPTZ(6),
  "status" "GraphSyncJobStatus" NOT NULL DEFAULT 'idle',
  CONSTRAINT "graph_sync_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "graph_sync_jobs_workspace_id_connector_id_status_idx"
  ON "graph_sync_jobs"("workspace_id","connector_id","status");

-- Foreign keys
ALTER TABLE "graph_facts" ADD CONSTRAINT "graph_facts_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_merged_into_id_fkey"
  FOREIGN KEY ("merged_into_id") REFERENCES "graph_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_from_node_id_fkey"
  FOREIGN KEY ("from_node_id") REFERENCES "graph_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_to_node_id_fkey"
  FOREIGN KEY ("to_node_id") REFERENCES "graph_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_source_fact_id_fkey"
  FOREIGN KEY ("source_fact_id") REFERENCES "graph_facts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "graph_edges" ADD CONSTRAINT "graph_edges_superseded_by_id_fkey"
  FOREIGN KEY ("superseded_by_id") REFERENCES "graph_edges"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "graph_er_queue" ADD CONSTRAINT "graph_er_queue_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_er_queue" ADD CONSTRAINT "graph_er_queue_node_a_id_fkey"
  FOREIGN KEY ("node_a_id") REFERENCES "graph_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_er_queue" ADD CONSTRAINT "graph_er_queue_node_b_id_fkey"
  FOREIGN KEY ("node_b_id") REFERENCES "graph_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_connectors" ADD CONSTRAINT "graph_connectors_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_sync_jobs" ADD CONSTRAINT "graph_sync_jobs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "graph_sync_jobs" ADD CONSTRAINT "graph_sync_jobs_connector_id_fkey"
  FOREIGN KEY ("connector_id") REFERENCES "graph_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS (spec §9.2): tenant isolation enforced at the database level.
-- FORCE so the table owner is also constrained; the tenant principal is
-- the app.workspace_id GUC. Sessions without the GUC set see ZERO rows
-- (fail-closed). lib/substrate/graph/rls.ts sets it per transaction.
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'graph_facts','graph_nodes','graph_edges','graph_er_queue',
    'graph_connectors','graph_sync_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t
    );
  END LOOP;
END $$;
