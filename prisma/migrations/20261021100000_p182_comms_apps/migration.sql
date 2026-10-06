-- ShapesOS Phase 18.2 (WS=comms): the communication apps.
--
--   chat_channels / team_chat_messages  Messages: + workspace_id (backfilled
--         from the project), channel kind (project | channel | dm), private
--         channels, DM key, thread parent, agent authors, mentions. The
--         existing per-project channels keep working as kind "project".
--   chat_channel_members  membership + read cursor (people and agents)
--   user_presence         last-seen heartbeat per member
--   mail_thread_cache     Mail: thread headers per mailbox (no bodies)
--   mail_drafts           Mail: compose state and the inbox agent's drafts
--   calendar_feed_tokens  Calendar: private ICS feed tokens (sha256 only)
--   contact_identities / contact_identity_links / contact_merge_suggestions
--                         Contacts: the identity-link layer over the four
--                         people stores (merges only when a person confirms)
--   meeting_sessions      Meet: calls and what the meeting agent made of them
--   ops_tasks             Reminders: project_id becomes optional (a personal
--                         reminder), + repeat_rule, reminder_notified_at, source_ref
--   NotificationKind      + mention, direct_message, reminder_due
--
-- Every table here is FORCE RLS on app.workspace_id (fail-closed), including
-- the two chat tables that had no tenant column before.

-- CreateEnum
CREATE TYPE "ChatChannelKind" AS ENUM ('project', 'channel', 'dm');

-- AlterEnum (Postgres 12+ allows ADD VALUE in a transaction; the new
-- values are not used until a later transaction).
ALTER TYPE "NotificationKind" ADD VALUE 'mention';
ALTER TYPE "NotificationKind" ADD VALUE 'direct_message';
ALTER TYPE "NotificationKind" ADD VALUE 'reminder_due';

-- AlterTable
ALTER TABLE "chat_channels" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "dm_key" TEXT,
ADD COLUMN     "is_private" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" "ChatChannelKind" NOT NULL DEFAULT 'project',
ADD COLUMN     "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "topic" TEXT,
ADD COLUMN     "workspace_id" TEXT,
ALTER COLUMN "project_id" DROP NOT NULL;

-- Backfill: the original channels are per project (projects.workspace_id).
UPDATE "chat_channels" c SET "workspace_id" = p."workspace_id" FROM "projects" p WHERE p."id" = c."project_id";
-- A project's channel's last message time.
UPDATE "chat_channels" c SET "last_message_at" = m.last_at
  FROM (SELECT "channel_id", max("created_at") AS last_at FROM "team_chat_messages" GROUP BY "channel_id") m
 WHERE m."channel_id" = c."id";
ALTER TABLE "chat_channels" ALTER COLUMN "workspace_id" SET NOT NULL;
-- A project channel has its project; only a DM has a dm key.
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_kind_project_check" CHECK (("kind" = 'project') = ("project_id" IS NOT NULL));
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_kind_dm_check" CHECK (("kind" = 'dm') = ("dm_key" IS NOT NULL));

-- AlterTable
ALTER TABLE "team_chat_messages" ADD COLUMN     "agent_key" TEXT,
ADD COLUMN     "author_kind" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "edited_at" TIMESTAMP(3),
ADD COLUMN     "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "meta" JSONB,
ADD COLUMN     "parent_id" TEXT,
ADD COLUMN     "workspace_id" TEXT;

-- Backfill from the channel (already backfilled above).
UPDATE "team_chat_messages" m SET "workspace_id" = c."workspace_id" FROM "chat_channels" c WHERE c."id" = m."channel_id";
ALTER TABLE "team_chat_messages" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "team_chat_messages" ADD CONSTRAINT "team_chat_messages_author_kind_check" CHECK ("author_kind" IN ('user', 'agent', 'system'));

-- AlterTable
ALTER TABLE "ops_tasks" ADD COLUMN     "reminder_notified_at" TIMESTAMP(3),
ADD COLUMN     "repeat_rule" TEXT,
ADD COLUMN     "source_ref" TEXT,
ALTER COLUMN "project_id" DROP NOT NULL;
ALTER TABLE "ops_tasks" ADD CONSTRAINT "ops_tasks_repeat_rule_check" CHECK ("repeat_rule" IS NULL OR "repeat_rule" IN ('daily', 'weekly', 'monthly'));

-- CreateTable
CREATE TABLE "chat_channel_members" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "member_key" TEXT NOT NULL,
    "user_id" TEXT,
    "agent_key" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "last_read_at" TIMESTAMP(3),
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_channel_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_presence" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_presence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_thread_cache" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "latest_message_id" TEXT,
    "subject" TEXT NOT NULL,
    "from_name" TEXT,
    "from_email" TEXT,
    "participants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_message_at" TIMESTAMP(3) NOT NULL,
    "message_count" INTEGER NOT NULL DEFAULT 1,
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "suggested_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "summarized_at" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_thread_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_drafts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "connection_id" TEXT,
    "thread_key" TEXT,
    "reply_to_message_id" TEXT,
    "to" TEXT,
    "cc" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'person',
    "agent_key" TEXT,
    "run_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sent_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_feed_tokens" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "calendar_feed_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_identities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "companies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "record_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_identity_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "record_kind" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "linked_via" TEXT NOT NULL DEFAULT 'sync',
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_identity_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_merge_suggestions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "a_kind" TEXT NOT NULL,
    "a_id" TEXT NOT NULL,
    "b_kind" TEXT NOT NULL,
    "b_id" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposed_via" TEXT NOT NULL DEFAULT 'sync',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_merge_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "room_name" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'adhoc',
    "origin_ref" TEXT,
    "started_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "transcript" TEXT,
    "transcript_source" TEXT NOT NULL DEFAULT 'none',
    "summary" JSONB,
    "notes_doc_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_channel_members_workspace_id_user_id_idx" ON "chat_channel_members"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_channel_members_channel_id_member_key_key" ON "chat_channel_members"("channel_id", "member_key");

-- CreateIndex
CREATE UNIQUE INDEX "user_presence_workspace_id_user_id_key" ON "user_presence"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "mail_thread_cache_workspace_id_owner_user_id_archived_last__idx" ON "mail_thread_cache"("workspace_id", "owner_user_id", "archived", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "mail_thread_cache_workspace_id_connection_id_external_id_key" ON "mail_thread_cache"("workspace_id", "connection_id", "external_id");

-- CreateIndex
CREATE INDEX "mail_drafts_workspace_id_user_id_status_idx" ON "mail_drafts"("workspace_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "mail_drafts_workspace_id_thread_key_idx" ON "mail_drafts"("workspace_id", "thread_key");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_feed_tokens_token_hash_key" ON "calendar_feed_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "calendar_feed_tokens_workspace_id_user_id_idx" ON "calendar_feed_tokens"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "contact_identities_workspace_id_display_name_idx" ON "contact_identities"("workspace_id", "display_name");

-- CreateIndex
CREATE INDEX "contact_identity_links_identity_id_idx" ON "contact_identity_links"("identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_identity_links_workspace_id_record_kind_record_id_key" ON "contact_identity_links"("workspace_id", "record_kind", "record_id");

-- CreateIndex
CREATE INDEX "contact_merge_suggestions_workspace_id_status_score_idx" ON "contact_merge_suggestions"("workspace_id", "status", "score");

-- CreateIndex
CREATE UNIQUE INDEX "contact_merge_suggestions_workspace_id_a_kind_a_id_b_kind_b_key" ON "contact_merge_suggestions"("workspace_id", "a_kind", "a_id", "b_kind", "b_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_sessions_room_name_key" ON "meeting_sessions"("room_name");

-- CreateIndex
CREATE INDEX "meeting_sessions_workspace_id_started_at_idx" ON "meeting_sessions"("workspace_id", "started_at");

-- CreateIndex
CREATE INDEX "chat_channels_workspace_id_kind_last_message_at_idx" ON "chat_channels"("workspace_id", "kind", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_channels_workspace_id_dm_key_key" ON "chat_channels"("workspace_id", "dm_key");

-- CreateIndex
CREATE INDEX "team_chat_messages_workspace_id_created_at_idx" ON "team_chat_messages"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "team_chat_messages_parent_id_created_at_idx" ON "team_chat_messages"("parent_id", "created_at");

-- CreateIndex
CREATE INDEX "ops_tasks_workspace_id_due_at_idx" ON "ops_tasks"("workspace_id", "due_at");

-- AddForeignKey
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_chat_messages" ADD CONSTRAINT "team_chat_messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_chat_messages" ADD CONSTRAINT "team_chat_messages_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "team_chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_thread_cache" ADD CONSTRAINT "mail_thread_cache_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_drafts" ADD CONSTRAINT "mail_drafts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_feed_tokens" ADD CONSTRAINT "calendar_feed_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_identity_links" ADD CONSTRAINT "contact_identity_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_identity_links" ADD CONSTRAINT "contact_identity_links_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "contact_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_merge_suggestions" ADD CONSTRAINT "contact_merge_suggestions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: tenant isolation on app.workspace_id. ENABLE + FORCE;
-- sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_channels', 'team_chat_messages', 'chat_channel_members', 'user_presence', 'mail_thread_cache', 'mail_drafts', 'calendar_feed_tokens', 'contact_identities', 'contact_identity_links', 'contact_merge_suggestions', 'meeting_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
