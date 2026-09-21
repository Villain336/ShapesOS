-- Marketr milestone 14: retention loops (AI search visibility, content decay,
-- competitor radar, composite visibility score).
-- New tables: ai_visibility_snapshots, content_decay_findings,
-- competitor_snapshots, competitor_radar_events, visibility_scores.
-- Workspace gains visibility_weights JSON. Audit enum extended.

-- Audit enums: add retention-loop actions (Postgres >= 9.1 supports ADD VALUE)
ALTER TYPE "FileChangeAction" ADD VALUE 'ai_visibility_snapshot';
ALTER TYPE "FileChangeAction" ADD VALUE 'decay_finding_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'decay_finding_resolved';
ALTER TYPE "FileChangeAction" ADD VALUE 'radar_event_detected';
ALTER TYPE "FileChangeAction" ADD VALUE 'visibility_score_computed';

-- Workspace: per-workspace visibility score weights (nullable JSON)
ALTER TABLE "workspaces" ADD COLUMN "visibility_weights" JSONB;

-- CreateTable: ai_visibility_snapshots
CREATE TABLE "ai_visibility_snapshots" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "keyword_id" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ai_overview_present" BOOLEAN NOT NULL DEFAULT false,
    "site_cited" BOOLEAN NOT NULL DEFAULT false,
    "cited_url" TEXT,
    "serp_features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "mock" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ai_visibility_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_visibility_snapshots_project_id_checked_at_idx" ON "ai_visibility_snapshots"("project_id", "checked_at");
CREATE INDEX "ai_visibility_snapshots_keyword_id_checked_at_idx" ON "ai_visibility_snapshots"("keyword_id", "checked_at");

-- CreateTable: content_decay_findings
CREATE TABLE "content_decay_findings" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "keyword_id" TEXT,
    "url" TEXT,
    "phrases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "decay_score" DOUBLE PRECISION NOT NULL,
    "peak_position" INTEGER,
    "current_position" INTEGER,
    "peak_at" TIMESTAMP(3),
    "suggested_action" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "status" TEXT NOT NULL DEFAULT 'open',
    "note" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "content_decay_findings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "content_decay_findings_project_id_status_idx" ON "content_decay_findings"("project_id", "status");

-- CreateTable: competitor_snapshots
CREATE TABLE "competitor_snapshots" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "competitor_domain" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keywords_json" JSONB NOT NULL,
    "mock" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "competitor_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "competitor_snapshots_project_id_competitor_domain_captured_at_idx" ON "competitor_snapshots"("project_id", "competitor_domain", "captured_at");

-- CreateTable: competitor_radar_events
CREATE TABLE "competitor_radar_events" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "competitor_domain" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "keyword_phrase" TEXT,
    "details" JSONB NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "competitor_radar_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "competitor_radar_events_project_id_detected_at_idx" ON "competitor_radar_events"("project_id", "detected_at");
CREATE INDEX "competitor_radar_events_project_id_competitor_domain_detected_at_idx" ON "competitor_radar_events"("project_id", "competitor_domain", "detected_at");

-- CreateTable: visibility_scores
CREATE TABLE "visibility_scores" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL,
    "components" JSONB NOT NULL,
    "mock" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "visibility_scores_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "visibility_scores_project_id_date_key" ON "visibility_scores"("project_id", "date");
CREATE INDEX "visibility_scores_project_id_date_idx" ON "visibility_scores"("project_id", "date");

-- Foreign keys
ALTER TABLE "ai_visibility_snapshots" ADD CONSTRAINT "ai_visibility_snapshots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_visibility_snapshots" ADD CONSTRAINT "ai_visibility_snapshots_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_decay_findings" ADD CONSTRAINT "content_decay_findings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "content_decay_findings" ADD CONSTRAINT "content_decay_findings_keyword_id_fkey" FOREIGN KEY ("keyword_id") REFERENCES "keywords"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "competitor_snapshots" ADD CONSTRAINT "competitor_snapshots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_radar_events" ADD CONSTRAINT "competitor_radar_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "visibility_scores" ADD CONSTRAINT "visibility_scores_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
