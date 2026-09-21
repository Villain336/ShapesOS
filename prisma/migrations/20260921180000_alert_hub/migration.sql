-- Marketr milestone 13: shared alerting hub (Slack, Telegram, email).
-- New tables: alert_channels, alert_rules, alert_events (+ implicit
-- _AlertRuleChannels join). Audit enum extended. WhatsApp deferred.

-- New enum types
CREATE TYPE "AlertChannelType" AS ENUM ('slack', 'telegram', 'email');
CREATE TYPE "AlertEventStatus" AS ENUM ('queued', 'sent', 'failed', 'suppressed');

-- Audit enums: add alert-hub actions (Postgres >= 9.1 supports ADD VALUE)
ALTER TYPE "FileChangeAction" ADD VALUE 'alert_channel_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'alert_channel_updated';
ALTER TYPE "FileChangeAction" ADD VALUE 'alert_channel_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'alert_rule_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'alert_rule_updated';
ALTER TYPE "FileChangeAction" ADD VALUE 'alert_rule_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'alert_sent';
ALTER TYPE "FileChangeAction" ADD VALUE 'alert_failed';

-- CreateTable: alert_channels
CREATE TABLE "alert_channels" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AlertChannelType" NOT NULL,
    "config_enc" TEXT NOT NULL,
    "hint" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable: alert_rules
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "cooldown_sec" INTEGER NOT NULL DEFAULT 3600,
    "digest" TEXT NOT NULL DEFAULT 'immediate',
    "quiet_hours" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_fired_at" TIMESTAMP(3),
    "last_digest_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable: alert_events
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "dedup_key" TEXT,
    "queue_reason" TEXT,
    "status" "AlertEventStatus" NOT NULL DEFAULT 'queued',
    "results" JSONB NOT NULL DEFAULT '[]',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- Implicit many-to-many join table _AlertRuleChannels (Prisma naming)
CREATE TABLE "_AlertRuleChannels" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_AlertRuleChannels_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "alert_channels_workspace_id_idx" ON "alert_channels"("workspace_id");
CREATE INDEX "alert_rules_workspace_id_trigger_idx" ON "alert_rules"("workspace_id", "trigger");
CREATE INDEX "alert_events_workspace_id_created_at_idx" ON "alert_events"("workspace_id", "created_at");
CREATE INDEX "alert_events_rule_id_created_at_idx" ON "alert_events"("rule_id", "created_at");
CREATE INDEX "alert_events_dedup_key_created_at_idx" ON "alert_events"("dedup_key", "created_at");
CREATE INDEX "_AlertRuleChannels_B_index" ON "_AlertRuleChannels"("B");

-- AddForeignKey
ALTER TABLE "alert_channels" ADD CONSTRAINT "alert_channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_AlertRuleChannels" ADD CONSTRAINT "_AlertRuleChannels_A_fkey" FOREIGN KEY ("A") REFERENCES "alert_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_AlertRuleChannels" ADD CONSTRAINT "_AlertRuleChannels_B_fkey" FOREIGN KEY ("B") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
