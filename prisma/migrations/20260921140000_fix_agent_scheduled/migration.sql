-- Marketr milestone 10: fix-agent scheduled rung.
-- New enum for per-site issue lifecycle; new tables for settings, audits, issues;
-- fix-agent actor + fix actions on the audit log; optional site link on fix_runs.

CREATE TYPE "SiteIssueStatus" AS ENUM ('open', 'approved', 'fixing', 'fixed', 'verified', 'ignored');

ALTER TYPE "FileChangeActor" ADD VALUE IF NOT EXISTS 'fix_agent';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'fix_applied';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'fix_reverted';

CREATE TABLE "fix_agent_settings" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "allowed_categories" TEXT[] NOT NULL DEFAULT '{}',
    "max_fixes_per_run" INTEGER NOT NULL DEFAULT 10,
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fix_agent_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "site_audits" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" "FixRunStatus" NOT NULL DEFAULT 'pending',
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "total_issues" INTEGER NOT NULL DEFAULT 0,
    "open_issues" INTEGER NOT NULL DEFAULT 0,
    "error_issues" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_audits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "site_issues" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "audit_id" TEXT,
    "category" TEXT NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "file_path" TEXT NOT NULL,
    "line" INTEGER,
    "detail" TEXT NOT NULL,
    "fix_hint" TEXT,
    "auto_fixable" BOOLEAN NOT NULL DEFAULT true,
    "destructive" BOOLEAN NOT NULL DEFAULT false,
    "status" "SiteIssueStatus" NOT NULL DEFAULT 'open',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "proposed_diff" TEXT,
    "fixed_at" TIMESTAMP(3),
    "fix_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "site_issues_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fix_agent_settings_site_id_key" ON "fix_agent_settings"("site_id");
CREATE INDEX "site_audits_site_id_created_at_idx" ON "site_audits"("site_id", "created_at");
CREATE INDEX "site_issues_site_id_status_idx" ON "site_issues"("site_id", "status");
CREATE INDEX "site_issues_site_id_category_status_idx" ON "site_issues"("site_id", "category", "status");

ALTER TABLE "fix_agent_settings" ADD CONSTRAINT "fix_agent_settings_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "site_audits" ADD CONSTRAINT "site_audits_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "site_audits" ADD CONSTRAINT "site_audits_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "site_issues" ADD CONSTRAINT "site_issues_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "site_issues" ADD CONSTRAINT "site_issues_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "site_issues" ADD CONSTRAINT "site_issues_audit_id_fkey"
    FOREIGN KEY ("audit_id") REFERENCES "site_audits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "site_issues" ADD CONSTRAINT "site_issues_fix_run_id_fkey"
    FOREIGN KEY ("fix_run_id") REFERENCES "fix_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "fix_runs" ADD COLUMN "site_id" TEXT;

ALTER TABLE "fix_runs" ADD CONSTRAINT "fix_runs_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
