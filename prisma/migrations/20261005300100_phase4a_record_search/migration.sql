-- ShapesOS Phase 4a: global record search (lib/search/records.ts, ⌘K
-- "Records"). Trigram GIN indexes so the workspace-scoped ILIKE / similarity
-- lookups stay index-backed as tables grow. Each expression here is the
-- exact expression the search SQL matches on (keep them in step).
-- Index names end in _trgm_idx: scripts/ci/check-schema-drift.mjs treats
-- those as intentional raw-SQL indexes (Prisma can't model gin_trgm_ops).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "crm_leads_search_trgm_idx" ON "crm_leads"
  USING gin ((name || ' ' || coalesce(email, '') || ' ' || coalesce(company, '') || ' ' || coalesce(phone, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "univer_docs_title_trgm_idx" ON "univer_docs"
  USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "workspace_files_search_trgm_idx" ON "workspace_files"
  USING gin ((filename || ' ' || logical_path) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "projects_domain_trgm_idx" ON "projects"
  USING gin (domain gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ops_projects_name_trgm_idx" ON "ops_projects"
  USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "missions_label_trgm_idx" ON "missions"
  USING gin ((coalesce(goal ->> 'label', template)) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "cad_projects_name_trgm_idx" ON "cad_projects"
  USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "esign_envelopes_title_trgm_idx" ON "esign_envelopes"
  USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "legal_documents_title_trgm_idx" ON "legal_documents"
  USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "clients_name_trgm_idx" ON "clients"
  USING gin (name gin_trgm_ops);
