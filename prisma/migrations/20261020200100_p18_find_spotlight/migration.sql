-- ShapesOS Phase 18.1 (WS=find): Spotlight (lib/search).
--
-- 1. search_texts / search_text_chunks: the text inside workspace files and
--    Office docs (extracted by lib/search/text-index.ts), chunked; each chunk
--    has a GENERATED full-text vector ('simple' || 'english') and a 384-d
--    MiniLM embedding (HNSW, cosine). Keyed by the file / doc id, cascading
--    with it. FORCE RLS on app.workspace_id (fail-closed).
-- 2. One GIN expression index per searchable table, on exactly the document
--    expression lib/search/fts.ts queries (names end in _search_tsv_idx, which
--    scripts/ci/check-schema-drift.mjs treats as intentional raw-SQL indexes).

CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "search_texts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "file_id" TEXT,
    "univer_doc_id" TEXT,
    "status" TEXT NOT NULL,
    "extractor" TEXT,
    "content_sha256" TEXT,
    "content" TEXT,
    "char_count" INTEGER NOT NULL DEFAULT 0,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "embedded_count" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_texts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "search_texts_source_check" CHECK (
      ("source" = 'file' AND "file_id" IS NOT NULL AND "univer_doc_id" IS NULL)
      OR ("source" = 'doc' AND "univer_doc_id" IS NOT NULL AND "file_id" IS NULL)
    ),
    CONSTRAINT "search_texts_status_check" CHECK ("status" IN ('indexed', 'empty', 'unsupported', 'failed', 'too_large'))
);

-- CreateTable
CREATE TABLE "search_text_chunks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "search_text_id" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "body") || to_tsvector('english', "body")) STORED,
    "embedding" vector(384),

    CONSTRAINT "search_text_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "search_texts_file_id_key" ON "search_texts"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "search_texts_univer_doc_id_key" ON "search_texts"("univer_doc_id");

-- CreateIndex
CREATE INDEX "search_texts_workspace_id_source_status_idx" ON "search_texts"("workspace_id", "source", "status");

-- CreateIndex
CREATE INDEX "search_text_chunks_workspace_id_idx" ON "search_text_chunks"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "search_text_chunks_search_text_id_idx_key" ON "search_text_chunks"("search_text_id", "idx");

-- Full text + nearest-neighbour indexes on the chunks.
CREATE INDEX IF NOT EXISTS "search_text_chunks_search_tsv_idx" ON "search_text_chunks" USING gin ("search_tsv");
-- Partial (like the Growth Memory HNSW indexes): chunks past the embedding
-- cap have no vector; queries say "embedding IS NOT NULL" to use it.
CREATE INDEX IF NOT EXISTS "search_text_chunks_embedding_hnsw_idx" ON "search_text_chunks"
  USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE ("embedding" IS NOT NULL);

-- AddForeignKey
ALTER TABLE "search_texts" ADD CONSTRAINT "search_texts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_texts" ADD CONSTRAINT "search_texts_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "workspace_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_texts" ADD CONSTRAINT "search_texts_univer_doc_id_fkey" FOREIGN KEY ("univer_doc_id") REFERENCES "univer_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_text_chunks" ADD CONSTRAINT "search_text_chunks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_text_chunks" ADD CONSTRAINT "search_text_chunks_search_text_id_fkey" FOREIGN KEY ("search_text_id") REFERENCES "search_texts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: the repo's tenant-isolation pattern. ENABLE + FORCE; the tenant
-- principal is the app.workspace_id GUC; no GUC = zero rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['search_texts', 'search_text_chunks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- ============================================================
-- Full-text expression indexes (lib/search/fts.ts FTS_DOCS, verbatim).
-- ============================================================
CREATE INDEX IF NOT EXISTS "crm_leads_search_tsv_idx" ON "crm_leads" USING gin ((to_tsvector('simple', name || ' ' || coalesce(email, '') || ' ' || coalesce(company, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(title, '')) || to_tsvector('english', name || ' ' || coalesce(email, '') || ' ' || coalesce(company, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(title, ''))));

CREATE INDEX IF NOT EXISTS "ops_projects_search_tsv_idx" ON "ops_projects" USING gin ((to_tsvector('simple', name) || to_tsvector('english', name)));

CREATE INDEX IF NOT EXISTS "missions_search_tsv_idx" ON "missions" USING gin ((to_tsvector('simple', coalesce(goal ->> 'label', template)) || to_tsvector('english', coalesce(goal ->> 'label', template))));

CREATE INDEX IF NOT EXISTS "cad_projects_search_tsv_idx" ON "cad_projects" USING gin ((to_tsvector('simple', name || ' ' || coalesce(description, '')) || to_tsvector('english', name || ' ' || coalesce(description, ''))));

CREATE INDEX IF NOT EXISTS "esign_envelopes_search_tsv_idx" ON "esign_envelopes" USING gin ((to_tsvector('simple', title || ' ' || coalesce(document_name, '')) || to_tsvector('english', title || ' ' || coalesce(document_name, ''))));

CREATE INDEX IF NOT EXISTS "legal_documents_search_tsv_idx" ON "legal_documents" USING gin ((to_tsvector('simple', title || ' ' || left(coalesce(notes, ''), 20000)) || to_tsvector('english', title || ' ' || left(coalesce(notes, ''), 20000))));

CREATE INDEX IF NOT EXISTS "clients_search_tsv_idx" ON "clients" USING gin ((to_tsvector('simple', name) || to_tsvector('english', name)));

CREATE INDEX IF NOT EXISTS "cad_bom_lines_search_tsv_idx" ON "cad_bom_lines" USING gin ((to_tsvector('simple', part_name || ' ' || coalesce(material_spec, '')) || to_tsvector('english', part_name || ' ' || coalesce(material_spec, ''))));

CREATE INDEX IF NOT EXISTS "datasets_search_tsv_idx" ON "datasets" USING gin ((to_tsvector('simple', name) || to_tsvector('english', name)));

CREATE INDEX IF NOT EXISTS "social_publications_search_tsv_idx" ON "social_publications" USING gin ((to_tsvector('simple', left(content, 20000)) || to_tsvector('english', left(content, 20000))));

CREATE INDEX IF NOT EXISTS "ops_contacts_search_tsv_idx" ON "ops_contacts" USING gin ((to_tsvector('simple', name || ' ' || coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(title, '') || ' ' || left(coalesce(notes, ''), 20000)) || to_tsvector('english', name || ' ' || coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(title, '') || ' ' || left(coalesce(notes, ''), 20000))));

CREATE INDEX IF NOT EXISTS "ops_companies_search_tsv_idx" ON "ops_companies" USING gin ((to_tsvector('simple', name || ' ' || coalesce(domain, '') || ' ' || coalesce(website, '') || ' ' || coalesce(industry, '') || ' ' || left(coalesce(notes, ''), 20000)) || to_tsvector('english', name || ' ' || coalesce(domain, '') || ' ' || coalesce(website, '') || ' ' || coalesce(industry, '') || ' ' || left(coalesce(notes, ''), 20000))));

CREATE INDEX IF NOT EXISTS "connector_agent_persons_search_tsv_idx" ON "connector_agent_persons" USING gin ((to_tsvector('simple', name) || to_tsvector('english', name)));

CREATE INDEX IF NOT EXISTS "ops_tickets_search_tsv_idx" ON "ops_tickets" USING gin ((to_tsvector('simple', subject || ' ' || coalesce(requester_name, '') || ' ' || coalesce(requester_email, '')) || to_tsvector('english', subject || ' ' || coalesce(requester_name, '') || ' ' || coalesce(requester_email, ''))));

CREATE INDEX IF NOT EXISTS "ops_ticket_messages_search_tsv_idx" ON "ops_ticket_messages" USING gin ((to_tsvector('simple', left(body, 20000)) || to_tsvector('english', left(body, 20000))));

CREATE INDEX IF NOT EXISTS "ops_deals_search_tsv_idx" ON "ops_deals" USING gin ((to_tsvector('simple', title || ' ' || coalesce(owner_name, '') || ' ' || coalesce(lost_reason, '')) || to_tsvector('english', title || ' ' || coalesce(owner_name, '') || ' ' || coalesce(lost_reason, ''))));

CREATE INDEX IF NOT EXISTS "ai_chat_messages_search_tsv_idx" ON "ai_chat_messages" USING gin ((to_tsvector('simple', left(content, 20000)) || to_tsvector('english', left(content, 20000))));

CREATE INDEX IF NOT EXISTS "outbound_message_search_tsv_idx" ON "outbound_message" USING gin ((to_tsvector('simple', coalesce(subject, '') || ' ' || left(body, 20000)) || to_tsvector('english', coalesce(subject, '') || ' ' || left(body, 20000))));

CREATE INDEX IF NOT EXISTS "mini_apps_search_tsv_idx" ON "mini_apps" USING gin ((to_tsvector('simple', name || ' ' || coalesce(description, '')) || to_tsvector('english', name || ' ' || coalesce(description, ''))));

CREATE INDEX IF NOT EXISTS "univer_docs_search_tsv_idx" ON "univer_docs" USING gin ((to_tsvector('simple', title) || to_tsvector('english', title)));
