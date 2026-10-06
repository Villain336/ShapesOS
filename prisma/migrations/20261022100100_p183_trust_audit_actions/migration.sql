-- ShapesOS Phase 18.3 (WS=trust): audit actions of the Privacy & Security
-- center (FileChangeAction): an admin changed which apps agents may use, a
-- person signed a session out, a memory was forgotten, a phone was removed
-- from push, the audit timeline was exported.

-- AlterEnum
ALTER TYPE "FileChangeAction" ADD VALUE 'agent_app_access_changed';
ALTER TYPE "FileChangeAction" ADD VALUE 'session_revoked';
ALTER TYPE "FileChangeAction" ADD VALUE 'memory_forgotten';
ALTER TYPE "FileChangeAction" ADD VALUE 'push_device_removed';
ALTER TYPE "FileChangeAction" ADD VALUE 'audit_timeline_exported';
