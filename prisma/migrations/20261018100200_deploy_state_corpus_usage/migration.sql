-- Deploy PR (WS=state): knowledge-corpus retrieval counters
-- (lib/intelligence/corpus/activity.ts recordRetrievalHits / readRetrievalUsage).
--
-- They lived in data/corpus/retrieval-usage.json, read-modify-written on
-- every retrieval: behind several replicas each one counted on its own disk
-- (and two concurrent writers lost updates). One atomic
-- INSERT ... ON CONFLICT DO UPDATE SET hits = hits + EXCLUDED.hits per batch
-- makes the counts exact across instances.
--
-- GLOBAL table — deliberately NO workspace_id and NO row-level security, like
-- rate_limit_buckets (20261007200000_p6_infra_rate_limit_buckets): the corpus
-- is a platform asset shared by every tenant; rows are corpus source ids,
-- counts and a timestamp, never tenant content. Only activity.ts reads or
-- writes it. The runtime app role gets SELECT/INSERT/UPDATE/DELETE through the
-- default privileges in scripts/db/create-app-role.sql.

-- CreateTable
CREATE TABLE "corpus_retrieval_usage" (
    "source_id" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "last_hit_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "corpus_retrieval_usage_pkey" PRIMARY KEY ("source_id")
);
