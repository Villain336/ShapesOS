-- Marketr milestone 15: link intelligence (backlink intelligence + internal-linking suggestions).
-- New tables: backlinks, backlink_summaries, backlink_pulls, internal_link_suggestions.
-- New enums: BacklinkStatus, InternalLinkSuggestionStatus.
-- Project gains backlinks_enabled toggle. Workspace gains backlinks_spend_cap_usd.
-- Audit enum extended. (Hand-written — no PostgreSQL in sandbox; review before deploy.)

-- Audit enums: add link-intelligence actions (Postgres >= 9.1 supports ADD VALUE)
ALTER TYPE "FileChangeAction" ADD VALUE 'backlink_pull';
ALTER TYPE "FileChangeAction" ADD VALUE 'internal_link_suggestion_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'internal_link_suggestion_applied';
ALTER TYPE "FileChangeAction" ADD VALUE 'internal_link_suggestion_dismissed';

-- New enums
CREATE TYPE "BacklinkStatus" AS ENUM ('active', 'lost');
CREATE TYPE "InternalLinkSuggestionStatus" AS ENUM ('pending', 'applied', 'dismissed');

-- Project: weekly backlink refresh toggle
ALTER TABLE "projects" ADD COLUMN "backlinks_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Workspace: monthly backlinks spend cap (USD, nullable)
ALTER TABLE "workspaces" ADD COLUMN "backlinks_spend_cap_usd" DOUBLE PRECISION;

-- CreateTable: backlinks
CREATE TABLE "backlinks" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source_domain" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "target_url" TEXT NOT NULL,
    "anchor_text" TEXT,
    "dofollow" BOOLEAN NOT NULL DEFAULT true,
    "source_rank" INTEGER,
    "spam_score" INTEGER,
    "first_seen" TIMESTAMP(3),
    "last_seen" TIMESTAMP(3),
    "status" "BacklinkStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backlinks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "backlinks_project_id_source_url_target_url_key" ON "backlinks"("project_id", "source_url", "target_url");
CREATE INDEX "backlinks_project_id_status_idx" ON "backlinks"("project_id", "status");
CREATE INDEX "backlinks_project_id_source_domain_idx" ON "backlinks"("project_id", "source_domain");

-- CreateTable: backlink_summaries
CREATE TABLE "backlink_summaries" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "total" INTEGER NOT NULL,
    "referring_domains" INTEGER NOT NULL,
    "dofollow_ratio" DOUBLE PRECISION,
    "snapshot" JSONB NOT NULL,
    "mock" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "backlink_summaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "backlink_summaries_project_id_date_key" ON "backlink_summaries"("project_id", "date");
CREATE INDEX "backlink_summaries_project_id_date_idx" ON "backlink_summaries"("project_id", "date");

-- CreateTable: backlink_pulls
CREATE TABLE "backlink_pulls" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "rows_requested" INTEGER NOT NULL,
    "rows_returned" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DOUBLE PRECISION NOT NULL,
    "actual_cost_usd" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backlink_pulls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "backlink_pulls_workspace_id_created_at_idx" ON "backlink_pulls"("workspace_id", "created_at");
CREATE INDEX "backlink_pulls_project_id_created_at_idx" ON "backlink_pulls"("project_id", "created_at");

-- CreateTable: internal_link_suggestions
CREATE TABLE "internal_link_suggestions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "target_url" TEXT NOT NULL,
    "suggested_anchor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "status" "InternalLinkSuggestionStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "internal_link_suggestions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "internal_link_suggestions_project_id_status_idx" ON "internal_link_suggestions"("project_id", "status");
CREATE INDEX "internal_link_suggestions_project_id_score_idx" ON "internal_link_suggestions"("project_id", "score");

-- Foreign keys
ALTER TABLE "backlinks" ADD CONSTRAINT "backlinks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "backlink_summaries" ADD CONSTRAINT "backlink_summaries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "backlink_pulls" ADD CONSTRAINT "backlink_pulls_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "backlink_pulls" ADD CONSTRAINT "backlink_pulls_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "internal_link_suggestions" ADD CONSTRAINT "internal_link_suggestions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
