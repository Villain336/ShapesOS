-- CreateEnum
CREATE TYPE "AttributionTouchType" AS ENUM ('first', 'visit', 'form', 'call', 'manual');

-- AlterEnum
ALTER TYPE "LeadActivityType" ADD VALUE 'revenue';

-- CreateTable
CREATE TABLE "attr_touches" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "source" TEXT,
    "medium" TEXT,
    "campaign" TEXT,
    "content_id" TEXT,
    "touch_type" "AttributionTouchType" NOT NULL DEFAULT 'visit',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedup_hash" TEXT NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attr_touches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attr_spend" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "campaign" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attr_spend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attr_touches_workspace_id_channel_idx" ON "attr_touches"("workspace_id", "channel");

-- CreateIndex
CREATE INDEX "attr_touches_workspace_id_campaign_idx" ON "attr_touches"("workspace_id", "campaign");

-- CreateIndex
CREATE INDEX "attr_touches_workspace_id_occurred_at_idx" ON "attr_touches"("workspace_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "attr_touches_lead_id_dedup_hash_key" ON "attr_touches"("lead_id", "dedup_hash");

-- CreateIndex
CREATE INDEX "attr_spend_workspace_id_channel_idx" ON "attr_spend"("workspace_id", "channel");

-- CreateIndex
CREATE INDEX "attr_spend_workspace_id_period_start_period_end_idx" ON "attr_spend"("workspace_id", "period_start", "period_end");

-- AddForeignKey
ALTER TABLE "attr_touches" ADD CONSTRAINT "attr_touches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attr_touches" ADD CONSTRAINT "attr_touches_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attr_spend" ADD CONSTRAINT "attr_spend_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
