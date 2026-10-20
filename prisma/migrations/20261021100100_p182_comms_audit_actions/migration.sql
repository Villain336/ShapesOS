-- ShapesOS Phase 18.2 (WS=comms): audit actions of the communication apps
-- (FileChangeAction): a person confirmed / rejected a contact merge or
-- unlinked a record, sent mail from the Mail app, saved a calendar event,
-- created / revoked a private calendar feed.

-- AlterEnum
ALTER TYPE "FileChangeAction" ADD VALUE 'contact_merge_confirmed';
ALTER TYPE "FileChangeAction" ADD VALUE 'contact_merge_rejected';
ALTER TYPE "FileChangeAction" ADD VALUE 'contact_unlinked';
ALTER TYPE "FileChangeAction" ADD VALUE 'mail_sent';
ALTER TYPE "FileChangeAction" ADD VALUE 'calendar_event_saved';
ALTER TYPE "FileChangeAction" ADD VALUE 'calendar_feed_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'calendar_feed_revoked';
