-- Marketr Phase C gaps (G1): audit enum value for the scheduler pre-run cap gate.
--
-- When the pre-run checkCap() refuses a run (T9), the run is recorded with
-- status 'blocked' and an audit row with action 'scheduler_run_blocked_cap'.
-- Enum addition only — backwards compatible, no data backfill.

ALTER TYPE "FileChangeAction" ADD VALUE 'scheduler_run_blocked_cap';
