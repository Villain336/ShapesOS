-- ShapesOS Phase 18.3 (WS=flow): audit actions for Time Machine (snapshots,
-- restore into a new workspace, snapshot settings) and "Undo this agent run"
-- (lib/auditlog.ts). Separate migration: a new enum value can't be used in
-- the transaction that adds it.

ALTER TYPE "FileChangeAction" ADD VALUE 'snapshot_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'snapshot_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'snapshot_downloaded';
ALTER TYPE "FileChangeAction" ADD VALUE 'snapshot_restored';
ALTER TYPE "FileChangeAction" ADD VALUE 'snapshot_settings_changed';
ALTER TYPE "FileChangeAction" ADD VALUE 'agent_run_undone';
