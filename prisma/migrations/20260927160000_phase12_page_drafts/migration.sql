-- Marketr — Phase 12 (Worker 1): GrapesJS page drafts (landing pages + email templates).
CREATE TABLE "page_drafts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'landing',
    "template_key" TEXT,
    "html" TEXT,
    "css" TEXT,
    "components" JSONB,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "page_drafts_workspace_id_updated_at_idx" ON "page_drafts"("workspace_id", "updated_at");

ALTER TABLE "page_drafts" ADD CONSTRAINT "page_drafts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
