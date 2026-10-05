-- ShapesOS Phase 4a (GDPR): audit action for a full workspace data export
-- (GET /api/workspaces/[id]/export). Lands in the workspace's own audit log.
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'workspace_exported';
