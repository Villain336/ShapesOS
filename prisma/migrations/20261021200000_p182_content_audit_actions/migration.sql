-- ShapesOS Phase 18.2 (WS=content): audit actions for notes, file versions /
-- sharing / access, the terminal and the Store (lib/auditlog.ts).
-- Separate migration: a new enum value can't be used in the transaction
-- that adds it.

ALTER TYPE "FileChangeAction" ADD VALUE 'note_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'doc_version_restored';
ALTER TYPE "FileChangeAction" ADD VALUE 'file_version_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'file_version_restored';
ALTER TYPE "FileChangeAction" ADD VALUE 'file_share_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'file_share_revoked';
ALTER TYPE "FileChangeAction" ADD VALUE 'file_access_changed';
ALTER TYPE "FileChangeAction" ADD VALUE 'terminal_session_started';
ALTER TYPE "FileChangeAction" ADD VALUE 'terminal_session_ended';
ALTER TYPE "FileChangeAction" ADD VALUE 'store_item_installed';
ALTER TYPE "FileChangeAction" ADD VALUE 'store_item_removed';
ALTER TYPE "FileChangeAction" ADD VALUE 'store_item_published';
ALTER TYPE "FileChangeAction" ADD VALUE 'store_publication_accepted';
ALTER TYPE "FileChangeAction" ADD VALUE 'store_publication_declined';
