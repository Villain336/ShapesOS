-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('self_hosted', 'starter', 'pro', 'agency');

-- CreateEnum
CREATE TYPE "KeywordIntent" AS ENUM ('informational', 'navigational', 'commercial', 'transactional', 'unknown');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('brief', 'draft', 'editing', 'published');

-- CreateEnum
CREATE TYPE "ClientRole" AS ENUM ('viewer', 'editor', 'admin');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('info', 'warning', 'error', 'critical');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('open', 'queued', 'fixed', 'ignored');

-- CreateEnum
CREATE TYPE "FixMode" AS ENUM ('manual', 'scheduled', 'autopilot');

-- CreateEnum
CREATE TYPE "FixRunStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'rolled_back');

-- CreateEnum
CREATE TYPE "ApiMeter" AS ENUM ('tracked_keywords', 'ai_words', 'serp_calls');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'self_hosted',
    "white_label_logo_url" TEXT,
    "white_label_custom_domain" TEXT,
    "white_label_brand_color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "search_engine" TEXT NOT NULL DEFAULT 'google',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keywords" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "volume" INTEGER,
    "difficulty" DOUBLE PRECISION,
    "cpc" DOUBLE PRECISION,
    "intent" "KeywordIntent" NOT NULL DEFAULT 'unknown',
    "list" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rankings" (
    "id" TEXT NOT NULL,
    "keyword_id" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "position" INTEGER,
    "url" TEXT,
    "ai_overview_present" BOOLEAN NOT NULL DEFAULT false,
    "serp_features" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "rankings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitors" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "keyword_id" TEXT,
    "status" "ContentStatus" NOT NULL DEFAULT 'brief',
    "outline_json" JSONB,
    "body_markdown" TEXT,
    "seo_score" DOUBLE PRECISION,
    "published_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "login_email" TEXT NOT NULL,
    "viewer_role" "ClientRole" NOT NULL DEFAULT 'viewer',
    "report_schedule" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "pdf_url" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "meter" "ApiMeter" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "url" TEXT,
    "detail_json" JSONB,
    "status" "IssueStatus" NOT NULL DEFAULT 'open',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fix_runs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "mode" "FixMode" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fixes_applied" INTEGER NOT NULL DEFAULT 0,
    "snapshot_ref" TEXT,
    "status" "FixRunStatus" NOT NULL DEFAULT 'pending',
    "report_summary" TEXT,

    CONSTRAINT "fix_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "keywords_project_id_phrase_key" ON "keywords"("project_id", "phrase");

-- CreateIndex
CREATE INDEX "rankings_keyword_id_checked_at_idx" ON "rankings"("keyword_id", "checked_at");

-- CreateIndex
CREATE UNIQUE INDEX "competitors_project_id_domain_key" ON "competitors"("project_id", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "clients_workspace_id_login_email_key" ON "clients"("workspace_id", "login_email");

-- CreateIndex
CREATE UNIQUE INDEX "api_usage_workspace_id_meter_period_key" ON "api_usage"("workspace_id", "meter", "period");

-- CreateIndex
CREATE INDEX "issues_project_id_status_idx" ON "issues"("project_id", "status");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fix_runs" ADD CONSTRAINT "fix_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

