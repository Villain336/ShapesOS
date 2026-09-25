-- Marketr — Phase 8 G3: Growth Memory substrate (SPEC-PHASE8.md §2 G3, §4).
--
-- Three stores (memory_episodes / memory_facts / memory_learnings) +
-- cross-tenant playbook_learnings (anonymized, human-reviewed) +
-- memory_consolidation_runs (worker bookkeeping) + the unified
-- memory_index_view for hybrid retrieval.
--
-- EXTENSIONS (spec §9.12 — honest failure, never silent degraded mode):
--   pg_trgm  — fuzzy/trigram matching for the lexical side of recall.
--   vector   — pgvector HNSW for the vector side of recall.
-- If either CREATE EXTENSION fails, this migration FAILS LOUDLY and nothing
-- is half-built. Setup guidance for self-hosters on minimal Postgres:
--   1. Install the contrib + vector packages for your Postgres version:
--        Debian/Ubuntu: apt install postgresql-contrib postgresql-16-pgvector
--        (or build pg_trgm from the Postgres source tree with USE_PGXS=1)
--   2. As a superuser: CREATE EXTENSION pg_trgm; CREATE EXTENSION vector;
--   3. Re-run the migration.
-- The DO block below turns a bare permission/availability error into this
-- guidance.

-- Honest pre-flight: fail with setup guidance when extensions are missing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    RAISE EXCEPTION
      'Phase 8 G3 migration blocked: the pg_trgm extension is not available in this Postgres installation. '
      'Install postgresql-contrib (or build contrib/pg_trgm from source with USE_PGXS=1), then re-run. '
      'See the migration header for full setup guidance. Refusing to continue in a degraded mode (spec §9.12).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION
      'Phase 8 G3 migration blocked: the pgvector extension is not available in this Postgres installation. '
      'Install pgvector for your Postgres version, then re-run. '
      'See the migration header for full setup guidance. Refusing to continue in a degraded mode (spec §9.12).';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- Enums (match Prisma native enum names)
CREATE TYPE "MemoryEpisodeType" AS ENUM ('run', 'session', 'sync', 'agent_call');
CREATE TYPE "MemoryLearningResult" AS ENUM ('worked', 'failed', 'inconclusive');
CREATE TYPE "MemoryLearningSource" AS ENUM ('test_lab', 'reallocation', 'campaign', 'human', 'import');

-- Episodic store: immutable run/session/sync/agent-call records.
CREATE TABLE "memory_episodes" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "episode_type" "MemoryEpisodeType" NOT NULL,
  "actor" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "refs" JSONB NOT NULL DEFAULT '{}',
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "ended_at" TIMESTAMPTZ(6),
  "embedding" vector(384),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- BM25 side of hybrid recall (auto-maintained, never written by app code).
  -- NOTE: enum casts are not immutable, so episode_type is excluded here
  -- (it stays queryable as a column and in the trigram/lexical path).
  "search_tsv" tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("actor", '') || ' ' || coalesce("summary", ''))
  ) STORED,
  CONSTRAINT "memory_episodes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "memory_episodes_workspace_id_episode_type_idx" ON "memory_episodes"("workspace_id", "episode_type");
CREATE INDEX "memory_episodes_workspace_id_started_at_idx" ON "memory_episodes"("workspace_id", "started_at");
CREATE INDEX "memory_episodes_search_tsv_idx" ON "memory_episodes" USING gin ("search_tsv");
CREATE INDEX "memory_episodes_summary_trgm_idx" ON "memory_episodes" USING gin ("summary" gin_trgm_ops);
CREATE INDEX "memory_episodes_embedding_hnsw_idx" ON "memory_episodes"
  USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL;

-- Semantic store: distilled facts, bi-temporal. Invalidation, never deletion.
CREATE TABLE "memory_facts" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "subject_node_id" TEXT,
  "predicate" TEXT NOT NULL,
  "object" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "valid_at" TIMESTAMPTZ(6) NOT NULL,
  "invalid_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expired_at" TIMESTAMPTZ(6),
  "source_episode_id" TEXT,
  "superseded_by_id" TEXT,
  -- decay-to-floor: user_told persists, agent_inferred fades, imported follows policy
  "origin" TEXT NOT NULL DEFAULT 'agent_inferred',
  "embedding" vector(384),
  "search_tsv" tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("predicate", '') || ' ' || coalesce("object"::text, ''))
  ) STORED,
  CONSTRAINT "memory_facts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "memory_facts_workspace_id_predicate_idx" ON "memory_facts"("workspace_id", "predicate");
CREATE INDEX "memory_facts_workspace_id_subject_node_id_idx" ON "memory_facts"("workspace_id", "subject_node_id");
CREATE INDEX "memory_facts_workspace_id_valid_at_idx" ON "memory_facts"("workspace_id", "valid_at");
CREATE INDEX "memory_facts_search_tsv_idx" ON "memory_facts" USING gin ("search_tsv");
CREATE INDEX "memory_facts_predicate_trgm_idx" ON "memory_facts" USING gin ("predicate" gin_trgm_ops);
CREATE INDEX "memory_facts_embedding_hnsw_idx" ON "memory_facts"
  USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL;

-- Procedural store: what worked / failed / when (F3 archive sink schema).
CREATE TABLE "memory_learnings" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "hypothesis" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "result" "MemoryLearningResult" NOT NULL,
  "metric_delta" JSONB NOT NULL DEFAULT '{}',
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "invalidated_at" TIMESTAMPTZ(6),
  "context_refs" JSONB NOT NULL DEFAULT '{}',
  "source" "MemoryLearningSource" NOT NULL,
  "source_episode_id" TEXT,
  "embedding" vector(384),
  -- NOTE: enum casts are not immutable in generated columns; result stays a
  -- plain column (and appears in the unified view's title).
  "search_tsv" tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("hypothesis", '') || ' ' || coalesce("action", '') || ' ' || coalesce("context_refs"::text, ''))
  ) STORED,
  CONSTRAINT "memory_learnings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "memory_learnings_workspace_id_result_idx" ON "memory_learnings"("workspace_id", "result");
CREATE INDEX "memory_learnings_workspace_id_observed_at_idx" ON "memory_learnings"("workspace_id", "observed_at");
CREATE INDEX "memory_learnings_workspace_id_source_idx" ON "memory_learnings"("workspace_id", "source");
CREATE INDEX "memory_learnings_search_tsv_idx" ON "memory_learnings" USING gin ("search_tsv");
CREATE INDEX "memory_learnings_hypothesis_trgm_idx" ON "memory_learnings" USING gin ("hypothesis" gin_trgm_ops);
CREATE INDEX "memory_learnings_embedding_hnsw_idx" ON "memory_learnings"
  USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE "embedding" IS NOT NULL;

-- Cross-client playbook patterns: NO workspace_id, deliberately cross-tenant.
-- Rows enter only via the anonymization transform + human review gate.
CREATE TABLE "playbook_learnings" (
  "id" TEXT NOT NULL,
  "pattern_title" TEXT NOT NULL,
  "pattern_body" TEXT NOT NULL,
  "supporting_client_count" INTEGER NOT NULL DEFAULT 1,
  "first_observed" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_observed" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "anonymization_reviewed_by" TEXT,
  "reviewed_at" TIMESTAMPTZ(6),
  CONSTRAINT "playbook_learnings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "playbook_learnings_reviewed_at_idx" ON "playbook_learnings"("reviewed_at");
CREATE INDEX "playbook_learnings_search_tsv_idx" ON "playbook_learnings"
  USING gin (to_tsvector('english', coalesce("pattern_title", '') || ' ' || coalesce("pattern_body", '')));

-- Consolidation worker bookkeeping (powers GET /api/substrate/memory/consolidation).
CREATE TABLE "memory_consolidation_runs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(6),
  "status" TEXT NOT NULL DEFAULT 'running',
  "episodes_scanned" INTEGER NOT NULL DEFAULT 0,
  "facts_distilled" INTEGER NOT NULL DEFAULT 0,
  "facts_invalidated" INTEGER NOT NULL DEFAULT 0,
  "learnings_deduped" INTEGER NOT NULL DEFAULT 0,
  "rows_pruned" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  CONSTRAINT "memory_consolidation_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "memory_consolidation_runs_workspace_id_started_at_idx"
  ON "memory_consolidation_runs"("workspace_id", "started_at" DESC);

-- Foreign keys
ALTER TABLE "memory_episodes" ADD CONSTRAINT "memory_episodes_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_subject_node_id_fkey"
  FOREIGN KEY ("subject_node_id") REFERENCES "graph_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_source_episode_id_fkey"
  FOREIGN KEY ("source_episode_id") REFERENCES "memory_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_superseded_by_id_fkey"
  FOREIGN KEY ("superseded_by_id") REFERENCES "memory_facts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "memory_learnings" ADD CONSTRAINT "memory_learnings_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_learnings" ADD CONSTRAINT "memory_learnings_source_episode_id_fkey"
  FOREIGN KEY ("source_episode_id") REFERENCES "memory_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "memory_consolidation_runs" ADD CONSTRAINT "memory_consolidation_runs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unified memory index view: the single surface hybrid recall reads.
-- (HNSW/tsvector/trigram indexes live on the base tables; RLS policies of
-- the base tables apply through the view, including FORCE.)
CREATE OR REPLACE VIEW "memory_index_view" AS
SELECT
  "workspace_id", 'episode'::text AS "store", "id" AS "ref_id",
  "episode_type"::text AS "title", "summary" AS "body",
  "actor" AS "subtitle",
  "started_at" AS "observed_at",
  "started_at" AS "valid_at", NULL::timestamptz AS "invalid_at",
  NULL::timestamptz AS "invalidated_at",
  "embedding", "search_tsv",
  "id" AS "episode_id"
FROM "memory_episodes"
UNION ALL
SELECT
  "workspace_id", 'fact'::text, "id",
  "predicate", "object"::text,
  "origin",
  "created_at",
  "valid_at", "invalid_at",
  "expired_at",
  "embedding", "search_tsv",
  "source_episode_id"
FROM "memory_facts"
UNION ALL
SELECT
  "workspace_id", 'learning'::text, "id",
  "result"::text || ': ' || left("hypothesis", 120),
  "hypothesis" || ' ||| ' || "action",
  "source"::text,
  "observed_at",
  "observed_at" AS "valid_at", NULL::timestamptz AS "invalid_at",
  "invalidated_at",
  "embedding", "search_tsv",
  "source_episode_id"
FROM "memory_learnings";

-- ============================================================
-- RLS (spec §9.2): tenant isolation enforced at the database level.
-- FORCE so the table owner is also constrained; the tenant principal is
-- the app.workspace_id GUC (shared with G1's graph tables).
-- Sessions without the GUC set see ZERO rows (fail-closed).
-- lib/substrate/memory/rls.ts sets it per transaction.
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memory_episodes','memory_facts','memory_learnings','memory_consolidation_runs'
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

-- playbook_learnings: cross-tenant by design (no workspace_id), but
-- unreviewed patterns NEVER publish (spec §9.3). FORCE RLS:
--   SELECT: only reviewed rows, unless the session carries the explicit
--           app.playbook_reviewer='1' gate (the human review queue UI).
--   INSERT/UPDATE/DELETE: service writes (propose via anonymization
--           transform, review actions) — the app layer enforces the gate.
DO $$
BEGIN
  ALTER TABLE "playbook_learnings" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE "playbook_learnings" FORCE ROW LEVEL SECURITY;
  CREATE POLICY "playbook_learnings_reviewed_read" ON "playbook_learnings"
    FOR SELECT
    USING ("reviewed_at" IS NOT NULL
           OR current_setting('app.playbook_reviewer', true) = '1');
  CREATE POLICY "playbook_learnings_propose" ON "playbook_learnings"
    FOR INSERT WITH CHECK (true);
  CREATE POLICY "playbook_learnings_review_write" ON "playbook_learnings"
    FOR UPDATE USING (true) WITH CHECK (true);
  CREATE POLICY "playbook_learnings_admin_delete" ON "playbook_learnings"
    FOR DELETE USING (true);
END $$;

-- Consolidation worker role (spec: separate pool/role with memory budgets).
-- Guarded: self-hosters running migrations as a non-superuser get a NOTICE,
-- not a failure — the worker then runs as the app role with in-session
-- budgets (loudly logged at startup, never silent).
DO $$
BEGIN
  CREATE ROLE marketr_memory_worker WITH LOGIN;
  RAISE NOTICE 'Phase 8 G3: created role marketr_memory_worker for the consolidation worker.';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Phase 8 G3: cannot CREATE ROLE (not superuser) — skipping marketr_memory_worker; the consolidation worker will run as the app role with in-session memory budgets.';
  WHEN duplicate_object THEN
    RAISE NOTICE 'Phase 8 G3: role marketr_memory_worker already exists.';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marketr_memory_worker') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO marketr_memory_worker', current_database());
    GRANT USAGE ON SCHEMA public TO marketr_memory_worker;
    GRANT SELECT, INSERT, UPDATE ON
      memory_episodes, memory_facts, memory_learnings,
      playbook_learnings, memory_consolidation_runs
      TO marketr_memory_worker;
    -- Memory budgets for the worker role (spec: vector work must not fight OLTP).
    ALTER ROLE marketr_memory_worker SET work_mem = '64MB';
    ALTER ROLE marketr_memory_worker SET statement_timeout = '120000';
    ALTER ROLE marketr_memory_worker SET maintenance_work_mem = '128MB';
  END IF;
END $$;
