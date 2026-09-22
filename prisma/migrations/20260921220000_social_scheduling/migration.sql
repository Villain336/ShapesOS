-- Marketr milestone 20: social calendar and scheduled publishing through Buffer.
-- (Hand-written — no PostgreSQL in sandbox; review before deploy.)

-- New enum
CREATE TYPE "SocialPostStatus" AS ENUM ('draft', 'scheduled', 'sent', 'failed', 'cancelled');

-- Audit enum additions
ALTER TYPE "FileChangeAction" ADD VALUE 'social_buffer_key_updated';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_buffer_key_revoked';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_channels_synced';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_channel_enabled';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_channel_disabled';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_post_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_post_updated';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_post_scheduled';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_post_sent';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_post_failed';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_post_cancelled';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_post_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'social_analytics_synced';

-- Workspace social settings (BYO Buffer access token, encrypted)
CREATE TABLE "social_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "buffer_token_enc" TEXT,
    "buffer_token_hint" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "social_settings_workspace_id_key" ON "social_settings"("workspace_id");

-- Buffer channels synced per project
CREATE TABLE "social_channels" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "buffer_profile_id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "handle" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_channels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "social_channels_project_id_buffer_profile_id_key" ON "social_channels"("project_id", "buffer_profile_id");
CREATE INDEX "social_channels_project_id_idx" ON "social_channels"("project_id");

-- Social posts (drafts, scheduled, dispatched via Buffer)
CREATE TABLE "social_posts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "services" TEXT[] NOT NULL,
    "scheduled_for" TIMESTAMP(3),
    "status" "SocialPostStatus" NOT NULL DEFAULT 'draft',
    "buffer_update_ids" JSONB NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "error" TEXT,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "stats_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "social_posts_project_id_idx" ON "social_posts"("project_id");
CREATE INDEX "social_posts_status_scheduled_for_idx" ON "social_posts"("status", "scheduled_for");

-- Foreign keys
ALTER TABLE "social_settings" ADD CONSTRAINT "social_settings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_channels" ADD CONSTRAINT "social_channels_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
