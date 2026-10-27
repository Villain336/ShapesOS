-- Phase 23: external share links for Office docs and Reports.
-- Mirrors workspace_file_shares (p182): tenant isolation FOR ALL plus one
-- SELECT-only public-lookup policy per table, gated on
-- app.doc_report_share_route = 'lookup' (set by lib/sharing/doc-shares.ts
-- resolveShareToken inside its transaction; every later read/write runs
-- under the link's own workspace scope).

-- CreateTable
CREATE TABLE "univer_doc_shares" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_hint" VARCHAR(8) NOT NULL,
    "label" TEXT,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "last_opened_at" TIMESTAMP(3),

    CONSTRAINT "univer_doc_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_shares" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_hint" VARCHAR(8) NOT NULL,
    "label" TEXT,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "last_opened_at" TIMESTAMP(3),

    CONSTRAINT "report_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "univer_doc_shares_token_hash_key" ON "univer_doc_shares"("token_hash");
CREATE INDEX "univer_doc_shares_workspace_id_doc_id_idx" ON "univer_doc_shares"("workspace_id", "doc_id");
CREATE UNIQUE INDEX "report_shares_token_hash_key" ON "report_shares"("token_hash");
CREATE INDEX "report_shares_workspace_id_report_id_idx" ON "report_shares"("workspace_id", "report_id");

-- Foreign keys
ALTER TABLE "univer_doc_shares" ADD CONSTRAINT "univer_doc_shares_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "univer_doc_shares" ADD CONSTRAINT "univer_doc_shares_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "univer_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS
ALTER TABLE "univer_doc_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "univer_doc_shares" FORCE ROW LEVEL SECURITY;
CREATE POLICY univer_doc_shares_tenant_isolation ON "univer_doc_shares" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY univer_doc_shares_public_route ON "univer_doc_shares" FOR SELECT
  USING (current_setting('app.doc_report_share_route', true) = 'lookup' AND "revoked_at" IS NULL);

ALTER TABLE "report_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "report_shares" FORCE ROW LEVEL SECURITY;
CREATE POLICY report_shares_tenant_isolation ON "report_shares" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY report_shares_public_route ON "report_shares" FOR SELECT
  USING (current_setting('app.doc_report_share_route', true) = 'lookup' AND "revoked_at" IS NULL);
