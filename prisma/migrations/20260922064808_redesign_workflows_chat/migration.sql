/*
  Warnings:

  - You are about to drop the column `prompt_history` on the `ad_creatives` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('draft', 'active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "WorkflowStepStatus" AS ENUM ('pending', 'running', 'waiting_approval', 'succeeded', 'failed', 'skipped');

-- DropIndex
DROP INDEX "ad_campaigns_project_id_idx";

-- DropIndex
DROP INDEX "programmatic_datasets_project_id_idx";

-- DropIndex
DROP INDEX "programmatic_templates_project_id_idx";

-- DropIndex
DROP INDEX "sites_project_id_idx";

-- DropIndex
DROP INDEX "social_channels_project_id_idx";

-- DropIndex
DROP INDEX "social_posts_project_id_idx";

-- DropIndex
DROP INDEX "social_posts_status_scheduled_for_idx";

-- AlterTable
ALTER TABLE "_AlertRuleChannels" RENAME CONSTRAINT "_AlertRuleChannels_pkey" TO "_AlertRuleChannels_AB_pkey";

-- AlterTable
ALTER TABLE "ad_creatives" DROP COLUMN "prompt_history",
ADD COLUMN     "promptHistory" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "project_assets" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "studio_canva_accounts" ALTER COLUMN "token_expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "connected_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "studio_domains" ALTER COLUMN "purchased_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "studio_porkbun_settings" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "studio_registrants" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "workspace_members" ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "invite_expires_at" SET DATA TYPE TIMESTAMP(3);

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'draft',
    "schedule" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_nodes" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "position_x" DOUBLE PRECISION NOT NULL,
    "position_y" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_edges" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "source_node_id" TEXT NOT NULL,
    "target_node_id" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "workflow_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'queued',
    "trigger_kind" TEXT NOT NULL,
    "created_by" TEXT,
    "error" TEXT,
    "pending_approval_item_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run_steps" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "node_kind" TEXT NOT NULL,
    "node_label" TEXT NOT NULL,
    "status" "WorkflowStepStatus" NOT NULL DEFAULT 'pending',
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "workflow_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chat_threads" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_chat_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chat_messages" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_channels" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Project chat',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_chat_messages" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflows_project_id_status_idx" ON "workflows"("project_id", "status");

-- CreateIndex
CREATE INDEX "workflow_nodes_workflow_id_idx" ON "workflow_nodes"("workflow_id");

-- CreateIndex
CREATE INDEX "workflow_edges_workflow_id_idx" ON "workflow_edges"("workflow_id");

-- CreateIndex
CREATE INDEX "workflow_runs_workflow_id_started_at_idx" ON "workflow_runs"("workflow_id", "started_at");

-- CreateIndex
CREATE INDEX "workflow_runs_project_id_started_at_idx" ON "workflow_runs"("project_id", "started_at");

-- CreateIndex
CREATE INDEX "workflow_run_steps_run_id_started_at_idx" ON "workflow_run_steps"("run_id", "started_at");

-- CreateIndex
CREATE INDEX "ai_chat_threads_project_id_user_id_updated_at_idx" ON "ai_chat_threads"("project_id", "user_id", "updated_at");

-- CreateIndex
CREATE INDEX "ai_chat_messages_thread_id_created_at_idx" ON "ai_chat_messages"("thread_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_channels_project_id_key" ON "chat_channels"("project_id");

-- CreateIndex
CREATE INDEX "team_chat_messages_channel_id_created_at_idx" ON "team_chat_messages"("channel_id", "created_at");

-- AddForeignKey
ALTER TABLE "ad_settings" ADD CONSTRAINT "ad_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_nodes" ADD CONSTRAINT "workflow_nodes_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_edges" ADD CONSTRAINT "workflow_edges_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_steps" ADD CONSTRAINT "workflow_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat_threads" ADD CONSTRAINT "ai_chat_threads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "ai_chat_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_chat_messages" ADD CONSTRAINT "team_chat_messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "competitor_radar_events_project_id_competitor_domain_detected_a" RENAME TO "competitor_radar_events_project_id_competitor_domain_detect_idx";

-- RenameIndex
ALTER INDEX "competitor_snapshots_project_id_competitor_domain_captured_at_i" RENAME TO "competitor_snapshots_project_id_competitor_domain_captured__idx";
