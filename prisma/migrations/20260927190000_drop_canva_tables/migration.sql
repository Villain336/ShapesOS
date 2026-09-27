-- Phase 13 Wave A: Canva retired (Tico decision 2026-09-27).
-- Drop the Canva account table and Canva-id columns. Nothing references them
-- (verified: only self-contained constraints on studio_canva_accounts).
-- NOTE: the six studio_canva_* values on the FileChangeAction enum are left in
-- place deliberately — PostgreSQL cannot drop enum values, and they are harmless
-- as unused labels. Historical migrations are immutable, so the ADD VALUE lines
-- there remain as records.
DROP TABLE IF EXISTS "studio_canva_accounts";
ALTER TABLE "project_assets" DROP COLUMN IF EXISTS "canva_design_id";
ALTER TABLE "mail_creative" DROP COLUMN IF EXISTS "canva_design_id";
ALTER TABLE "mail_creative" DROP COLUMN IF EXISTS "canva_export_id";
