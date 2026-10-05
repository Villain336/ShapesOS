-- ShapesOS Phase 15.4 (zernio): ad reports pulled through Zernio (Meta,
-- Google, TikTok, LinkedIn, Pinterest, X and OpenAI ads) land in the same
-- ad_platforms / paid_ad_campaigns / ad_reports tables as Amazon and
-- StackAdapt (lib/zernio/reports.ts → lib/adplatforms/reporting.ts).

-- AlterEnum
ALTER TYPE "AdPlatformKey" ADD VALUE 'zernio';
