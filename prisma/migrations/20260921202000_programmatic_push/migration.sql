-- Marketr milestone 17 push: publish programmatic pages through existing connectors.
-- New audit enum value + per-template default publish target + per-page publish
-- target overrides and remote refs for idempotent in-place updates.
-- (Hand-written — no PostgreSQL in sandbox; review before deploy.)

-- Audit enum: push action (Postgres >= 9.1 supports ADD VALUE)
ALTER TYPE "FileChangeAction" ADD VALUE 'programmatic_page_pushed';

-- Template-level default publish target
ALTER TABLE "programmatic_templates" ADD COLUMN "default_publish_target" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "programmatic_templates" ADD COLUMN "default_target_site_id" TEXT;
ALTER TABLE "programmatic_templates" ADD COLUMN "default_webflow_collection_id" TEXT;

-- Page-level overrides + remote refs
ALTER TABLE "programmatic_pages" ADD COLUMN "publish_target" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "programmatic_pages" ADD COLUMN "target_site_id" TEXT;
ALTER TABLE "programmatic_pages" ADD COLUMN "webflow_collection_id" TEXT;
ALTER TABLE "programmatic_pages" ADD COLUMN "external_id" TEXT;
ALTER TABLE "programmatic_pages" ADD COLUMN "external_url" TEXT;
