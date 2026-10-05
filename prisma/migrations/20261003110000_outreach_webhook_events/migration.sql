-- Phase 1: durable idempotency for Smartlead/Instantly webhook events. A
-- (provider, event id) is claimed before processing, so redeliveries and
-- replays collapse across instances and restarts.

-- CreateTable
CREATE TABLE "outreach_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outreach_webhook_events_workspace_id_received_at_idx" ON "outreach_webhook_events"("workspace_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_webhook_events_provider_event_id_key" ON "outreach_webhook_events"("provider", "event_id");

-- AddForeignKey
ALTER TABLE "outreach_webhook_events" ADD CONSTRAINT "outreach_webhook_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
