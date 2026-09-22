-- Marketr milestone 17: programmatic SEO builder.
-- New tables: programmatic_templates, programmatic_datasets, programmatic_pages.
-- New enum: ProgrammaticPageStatus.
-- Audit enum extended. (Hand-written — no PostgreSQL in sandbox; review before deploy.)

-- Audit enums: add programmatic-SEO actions (Postgres >= 9.1 supports ADD VALUE)
ALTER TYPE "FileChangeAction" ADD VALUE 'programmatic_template_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'programmatic_template_updated';
ALTER TYPE "FileChangeAction" ADD VALUE 'programmatic_template_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'programmatic_dataset_uploaded';
ALTER TYPE "FileChangeAction" ADD VALUE 'programmatic_dataset_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'programmatic_pages_generated';
ALTER TYPE "FileChangeAction" ADD VALUE 'programmatic_page_approved';
ALTER TYPE "FileChangeAction" ADD VALUE 'programmatic_page_published';
ALTER TYPE "FileChangeAction" ADD VALUE 'programmatic_page_discarded';

-- New enum
CREATE TYPE "ProgrammaticPageStatus" AS ENUM ('draft', 'ready', 'published', 'discarded');

-- CreateTable: programmatic_templates
CREATE TABLE "programmatic_templates" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url_pattern" TEXT NOT NULL,
    "title_template" TEXT NOT NULL,
    "description_template" TEXT NOT NULL,
    "content_blocks" JSONB NOT NULL,
    "min_word_count" INTEGER NOT NULL DEFAULT 300,
    "duplicate_rate_cap" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "noindex_until_approved" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "programmatic_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable: programmatic_datasets
CREATE TABLE "programmatic_datasets" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schema" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL,
    "column_mapping" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "programmatic_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable: programmatic_pages
CREATE TABLE "programmatic_pages" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "dataset_id" TEXT,
    "row_index" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "ProgrammaticPageStatus" NOT NULL DEFAULT 'draft',
    "content" JSONB,
    "content_hash" TEXT,
    "noindex" BOOLEAN NOT NULL DEFAULT true,
    "canonical" TEXT,
    "quality_flags" JSONB NOT NULL DEFAULT '[]',
    "published_url" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "programmatic_pages_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "programmatic_templates" ADD CONSTRAINT "programmatic_templates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "programmatic_datasets" ADD CONSTRAINT "programmatic_datasets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "programmatic_pages" ADD CONSTRAINT "programmatic_pages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "programmatic_pages" ADD CONSTRAINT "programmatic_pages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "programmatic_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "programmatic_pages" ADD CONSTRAINT "programmatic_pages_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "programmatic_datasets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Unique + indexes
ALTER TABLE "programmatic_pages" ADD CONSTRAINT "programmatic_pages_template_id_slug_key" UNIQUE ("template_id", "slug");
CREATE INDEX "programmatic_pages_project_id_status_idx" ON "programmatic_pages"("project_id", "status");
CREATE INDEX "programmatic_templates_project_id_idx" ON "programmatic_templates"("project_id");
CREATE INDEX "programmatic_datasets_project_id_idx" ON "programmatic_datasets"("project_id");
