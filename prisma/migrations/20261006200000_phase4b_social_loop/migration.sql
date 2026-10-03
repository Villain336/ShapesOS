-- ShapesOS Phase 4b: social loop (media posts, Studio -> social, engagement
-- -> attribution). social_publications is the ShapesOS-owned post record
-- (text, media in the workspace filesystem, UTM-tagged link, approval state,
-- provider refs). social_post_metrics holds engagement per post, channel and
-- day, ingested from the social provider (Postiz; mock without credentials).
-- Both tables are FORCE RLS on the app.workspace_id GUC (fail-closed).

-- CreateEnum
CREATE TYPE "SocialPublicationStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'scheduled', 'published', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "social_publications" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "link" TEXT,
    "utm_campaign" TEXT,
    "channels" JSONB NOT NULL DEFAULT '[]',
    "media" JSONB NOT NULL DEFAULT '[]',
    "publish_mode" TEXT NOT NULL DEFAULT 'now',
    "scheduled_for" TIMESTAMP(3),
    "status" "SocialPublicationStatus" NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'compose',
    "source_ref" TEXT,
    "provider" TEXT,
    "provider_refs" JSONB NOT NULL DEFAULT '[]',
    "requested_by" TEXT,
    "requested_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "published_at" TIMESTAMP(3),
    "error" TEXT,
    "metrics_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_post_metrics" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "publication_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'postiz',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_post_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_publications_workspace_id_status_idx" ON "social_publications"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "social_publications_workspace_id_scheduled_for_idx" ON "social_publications"("workspace_id", "scheduled_for");

-- CreateIndex
CREATE INDEX "social_publications_workspace_id_created_at_idx" ON "social_publications"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "social_post_metrics_workspace_id_day_idx" ON "social_post_metrics"("workspace_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "social_post_metrics_publication_id_integration_id_day_key" ON "social_post_metrics"("publication_id", "integration_id", "day");

-- AddForeignKey
ALTER TABLE "social_publications" ADD CONSTRAINT "social_publications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_post_metrics" ADD CONSTRAINT "social_post_metrics_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_post_metrics" ADD CONSTRAINT "social_post_metrics_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "social_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Record search (lib/search/records.ts): trigram index over the exact
-- expression the search matches on. Name ends in _trgm_idx so the drift
-- guard treats it as an intentional raw-SQL index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "social_publications_content_trgm_idx" ON "social_publications"
  USING gin (content gin_trgm_ops);

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-4a migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['social_publications', 'social_post_metrics'] LOOP
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
