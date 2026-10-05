-- ShapesOS Phase 11 (seotools): live-URL site audits + Core Web Vitals.
-- site_audits stays project-scoped (milestone 10; app-level authz via
-- ownedSite); these columns only widen what an audit row records.

-- AlterTable
ALTER TABLE "site_audits" ADD COLUMN     "crawl" JSONB,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'files',
ADD COLUMN     "target_url" TEXT,
ADD COLUMN     "vitals" JSONB;
