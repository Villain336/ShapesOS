-- Marketr milestone 16: local SEO (geo-grids, competitor + review intelligence, GBP scaffold).
-- New tables: local_grids, local_grid_results, local_competitors,
-- local_competitor_snapshots, reviews, review_summaries, local_pulls,
-- gbp_accounts, gbp_posts, gbp_insights.
-- New enum: ReviewSentiment.
-- Project gains local relations. Workspace gains local_seo_spend_cap_usd.
-- Audit enum extended. (Hand-written — no PostgreSQL in sandbox; review before deploy.)

-- Audit enums: add local-SEO actions (Postgres >= 9.1 supports ADD VALUE)
ALTER TYPE "FileChangeAction" ADD VALUE 'local_grid_run';
ALTER TYPE "FileChangeAction" ADD VALUE 'local_competitor_snapshot';
ALTER TYPE "FileChangeAction" ADD VALUE 'reviews_ingested';

-- New enum
CREATE TYPE "ReviewSentiment" AS ENUM ('pos', 'neu', 'neg');

-- Workspace: monthly local-SEO spend cap (USD, nullable)
ALTER TABLE "workspaces" ADD COLUMN "local_seo_spend_cap_usd" DOUBLE PRECISION;

-- CreateTable: local_grids
CREATE TABLE "local_grids" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "center_lat" DOUBLE PRECISION NOT NULL,
    "center_lng" DOUBLE PRECISION NOT NULL,
    "radius_miles" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "grid_size" INTEGER NOT NULL DEFAULT 5,
    "schedule" TEXT NOT NULL DEFAULT 'weekly',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_grids_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "local_grids_project_id_idx" ON "local_grids"("project_id");

-- CreateTable: local_grid_results
CREATE TABLE "local_grid_results" (
    "id" TEXT NOT NULL,
    "local_grid_id" TEXT NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cells" JSONB NOT NULL,
    "coverage_pct" DOUBLE PRECISION NOT NULL,
    "avg_position" DOUBLE PRECISION,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mock" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "local_grid_results_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "local_grid_results_local_grid_id_run_at_idx" ON "local_grid_results"("local_grid_id", "run_at");

-- CreateTable: local_competitors
CREATE TABLE "local_competitors" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "place_id" TEXT,
    "domain" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_snapshot_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_competitors_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "local_competitors_project_id_idx" ON "local_competitors"("project_id");

-- CreateTable: local_competitor_snapshots
CREATE TABLE "local_competitor_snapshots" (
    "id" TEXT NOT NULL,
    "local_competitor_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rating" DOUBLE PRECISION,
    "review_count" INTEGER,
    "categories" TEXT[] NOT NULL DEFAULT '{}',
    "address" TEXT,
    "mock" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "local_competitor_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "local_competitor_snapshots_local_competitor_id_date_idx" ON "local_competitor_snapshots"("local_competitor_id", "date");

-- CreateTable: reviews
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "author" TEXT,
    "rating" INTEGER,
    "text" TEXT,
    "published_at" TIMESTAMP(3),
    "sentiment" "ReviewSentiment" NOT NULL DEFAULT 'neu',
    "sentiment_via" TEXT NOT NULL DEFAULT 'heuristic',
    "responded" BOOLEAN NOT NULL DEFAULT false,
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "reviews_project_id_external_id_key" ON "reviews"("project_id", "external_id");
CREATE INDEX "reviews_project_id_rating_idx" ON "reviews"("project_id", "rating");
CREATE INDEX "reviews_project_id_sentiment_idx" ON "reviews"("project_id", "sentiment");

-- CreateTable: review_summaries
CREATE TABLE "review_summaries" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'weekly',
    "period_start" TIMESTAMP(3) NOT NULL,
    "avg_rating" DOUBLE PRECISION,
    "count" INTEGER NOT NULL,
    "pos_count" INTEGER NOT NULL DEFAULT 0,
    "neu_count" INTEGER NOT NULL DEFAULT 0,
    "neg_count" INTEGER NOT NULL DEFAULT 0,
    "top_themes" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_summaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "review_summaries_project_id_period_period_start_key" ON "review_summaries"("project_id", "period", "period_start");

-- CreateTable: local_pulls
CREATE TABLE "local_pulls" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "requests_made" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DOUBLE PRECISION NOT NULL,
    "actual_cost_usd" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_pulls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "local_pulls_workspace_id_created_at_idx" ON "local_pulls"("workspace_id", "created_at");
CREATE INDEX "local_pulls_project_id_created_at_idx" ON "local_pulls"("project_id", "created_at");

-- CreateTable: gbp_accounts (scaffold — behind FEATURE_GBP_MANAGEMENT)
CREATE TABLE "gbp_accounts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gbp_accounts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gbp_accounts_workspace_id_idx" ON "gbp_accounts"("workspace_id");

-- CreateTable: gbp_posts
CREATE TABLE "gbp_posts" (
    "id" TEXT NOT NULL,
    "gbp_account_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMP(3),
    "external_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gbp_posts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gbp_posts_gbp_account_id_status_idx" ON "gbp_posts"("gbp_account_id", "status");

-- CreateTable: gbp_insights
CREATE TABLE "gbp_insights" (
    "id" TEXT NOT NULL,
    "gbp_account_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "searches" INTEGER NOT NULL DEFAULT 0,
    "direction_requests" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "website_clicks" INTEGER NOT NULL DEFAULT 0,
    "mock" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "gbp_insights_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gbp_insights_gbp_account_id_location_id_date_key" ON "gbp_insights"("gbp_account_id", "location_id", "date");

-- AddForeignKey
ALTER TABLE "local_grids" ADD CONSTRAINT "local_grids_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "local_grid_results" ADD CONSTRAINT "local_grid_results_local_grid_id_fkey" FOREIGN KEY ("local_grid_id") REFERENCES "local_grids"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "local_competitors" ADD CONSTRAINT "local_competitors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "local_competitor_snapshots" ADD CONSTRAINT "local_competitor_snapshots_local_competitor_id_fkey" FOREIGN KEY ("local_competitor_id") REFERENCES "local_competitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_summaries" ADD CONSTRAINT "review_summaries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "local_pulls" ADD CONSTRAINT "local_pulls_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "local_pulls" ADD CONSTRAINT "local_pulls_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gbp_accounts" ADD CONSTRAINT "gbp_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gbp_posts" ADD CONSTRAINT "gbp_posts_gbp_account_id_fkey" FOREIGN KEY ("gbp_account_id") REFERENCES "gbp_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gbp_insights" ADD CONSTRAINT "gbp_insights_gbp_account_id_fkey" FOREIGN KEY ("gbp_account_id") REFERENCES "gbp_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
