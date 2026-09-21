-- Marketr milestone 12: brand kits + white-label reporting.
-- New tables: brand_kits, report_templates. Report gains template/brand-kit/
-- project refs, lifecycle status, local pdf path. Audit enums extended.

-- New enum types
CREATE TYPE "ReportStatus" AS ENUM ('queued', 'generating', 'ready', 'failed', 'sent');

-- AlterType for audit enums: add new values (Postgres >= 9.1 supports ADD VALUE)
ALTER TYPE "FileChangeActor" ADD VALUE 'system';
ALTER TYPE "FileChangeAction" ADD VALUE 'report_generated';
ALTER TYPE "FileChangeAction" ADD VALUE 'report_scheduled';

-- CreateTable: brand_kits
CREATE TABLE "brand_kits" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_path" TEXT,
    "colors" JSONB NOT NULL DEFAULT '{}',
    "fonts" JSONB NOT NULL DEFAULT '{}',
    "tone" TEXT,
    "client_id" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_kits_pkey" PRIMARY KEY ("id")
);

-- CreateTable: report_templates
CREATE TABLE "report_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'custom',
    "content" JSONB NOT NULL,
    "brand_kit_id" TEXT,
    "project_id" TEXT,
    "schedule" TEXT NOT NULL DEFAULT 'manual',
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_templates_pkey" PRIMARY KEY ("id")
);

-- AlterTable: reports gains M12 columns
ALTER TABLE "reports" ADD COLUMN "template_id" TEXT;
ALTER TABLE "reports" ADD COLUMN "brand_kit_id" TEXT;
ALTER TABLE "reports" ADD COLUMN "project_id" TEXT;
ALTER TABLE "reports" ADD COLUMN "pdf_path" TEXT;
ALTER TABLE "reports" ADD COLUMN "status" "ReportStatus" NOT NULL DEFAULT 'ready';
ALTER TABLE "reports" ADD COLUMN "error" TEXT;
-- Milestone 12: client becomes optional (template reports exist pre-send).
ALTER TABLE "reports" ALTER COLUMN "client_id" DROP NOT NULL;

-- Foreign keys
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_brand_kit_id_fkey" FOREIGN KEY ("brand_kit_id") REFERENCES "brand_kits"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "report_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_brand_kit_id_fkey" FOREIGN KEY ("brand_kit_id") REFERENCES "brand_kits"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
