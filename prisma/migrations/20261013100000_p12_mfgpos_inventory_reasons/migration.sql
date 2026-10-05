-- ShapesOS Phase 12 (mfgpos): stock-ledger reasons for manufacturing.
--   production   finished goods added by a completed manufacturing order (+)
--   consumption  components used up by a completed manufacturing order (−)
--   scrap        stock written off to the virtual scrap location (−)
-- Own migration: the values are only USED by later migrations' code paths.

ALTER TYPE "OpsInventoryReason" ADD VALUE IF NOT EXISTS 'production';
ALTER TYPE "OpsInventoryReason" ADD VALUE IF NOT EXISTS 'consumption';
ALTER TYPE "OpsInventoryReason" ADD VALUE IF NOT EXISTS 'scrap';
