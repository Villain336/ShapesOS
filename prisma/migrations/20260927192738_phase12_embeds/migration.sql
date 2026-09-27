-- Phase 12 (embeds): rrweb replay opt-in on share links, replay sessions,
-- Ghost publish columns on content items, Documenso signing requests.

-- AlterTable: replay opt-in flag on public share links (default off).
ALTER TABLE "design_shares" ADD COLUMN "replay_opt_in" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Ghost Admin API publish target on content items.
ALTER TABLE "content_items" ADD COLUMN "ghost_post_id" TEXT;
ALTER TABLE "content_items" ADD COLUMN "ghost_status" TEXT;
ALTER TABLE "content_items" ADD COLUMN "ghost_url" TEXT;

-- CreateTable: rrweb replay sessions (events = JSON array of eventWithTime).
CREATE TABLE "design_replay_sessions" (
    "id" TEXT NOT NULL,
    "share_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "design_id" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "design_replay_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Documenso API-only signing requests.
CREATE TABLE "signing_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "template_name" TEXT,
    "documenso_document_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "signers" JSONB NOT NULL DEFAULT '[]',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signing_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "design_replay_sessions_share_id_started_at_idx" ON "design_replay_sessions"("share_id", "started_at");
CREATE INDEX "design_replay_sessions_workspace_id_idx" ON "design_replay_sessions"("workspace_id");
CREATE INDEX "signing_requests_workspace_id_updated_at_idx" ON "signing_requests"("workspace_id", "updated_at");

-- AddForeignKey
ALTER TABLE "design_replay_sessions" ADD CONSTRAINT "design_replay_sessions_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "design_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "design_replay_sessions" ADD CONSTRAINT "design_replay_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signing_requests" ADD CONSTRAINT "signing_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
