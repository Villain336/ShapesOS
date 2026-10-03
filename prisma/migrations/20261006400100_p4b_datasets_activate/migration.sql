-- ShapesOS Phase 4b: Dataset Builder slices 3–4 follow-through.
-- Staleness alerts fire once per compiled version (the sweep in
-- lib/datasetbuilder/stale-sweep.ts records which version it alerted for;
-- a recompile re-arms it).

ALTER TABLE "datasets" ADD COLUMN "stale_alerted_version" INTEGER;
ALTER TABLE "datasets" ADD COLUMN "stale_alerted_at" TIMESTAMP(3);

-- Record search (lib/search/records.ts, kind "dataset").
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "datasets_name_trgm_idx" ON "datasets"
  USING gin (name gin_trgm_ops);
