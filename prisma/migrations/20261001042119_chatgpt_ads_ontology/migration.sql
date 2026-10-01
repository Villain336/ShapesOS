-- Wave 2 ChatGPT Ads slice 1: conversational-intent campaign ontology
-- (ChatGPTCampaign 1:1 extension of Phase 18 PaidAdCampaign, CreativeVariant
-- with lineage). Bought through the StackAdapt rail — no new AdPlatformKey.

-- CreateEnum
CREATE TYPE "ChatGPTCampaignStatus" AS ENUM ('draft', 'proposed', 'approved', 'live', 'paused', 'ended');

-- CreateEnum
CREATE TYPE "ChatGPTTier" AS ENUM ('free', 'go');

-- CreateEnum
CREATE TYPE "ChatGPTBidStrategy" AS ENUM ('cpc', 'cpm');

-- CreateEnum
CREATE TYPE "CreativeVariantSource" AS ENUM ('ai_generated', 'human');

-- CreateEnum
CREATE TYPE "CreativeApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "chatgpt_campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "objective" TEXT,
    "target_tiers" "ChatGPTTier"[] NOT NULL,
    "topic_intent_tags" TEXT[] NOT NULL,
    "budget_daily_cents" INTEGER,
    "budget_total_cents" INTEGER,
    "bid_strategy" "ChatGPTBidStrategy" NOT NULL DEFAULT 'cpc',
    "stackadapt_external_id" TEXT,
    "status" "ChatGPTCampaignStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chatgpt_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_variants" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "cta_label" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "source" "CreativeVariantSource" NOT NULL DEFAULT 'human',
    "ai_provider_used" TEXT,
    "ai_model_used" TEXT,
    "approval_status" "CreativeApprovalStatus" NOT NULL DEFAULT 'pending',
    "policy_flags" TEXT[] NOT NULL DEFAULT '{}',
    "parent_variant_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creative_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chatgpt_campaigns_campaign_id_key" ON "chatgpt_campaigns"("campaign_id");

-- CreateIndex
CREATE INDEX "chatgpt_campaigns_workspace_id_status_idx" ON "chatgpt_campaigns"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "creative_variants_workspace_id_campaign_id_idx" ON "creative_variants"("workspace_id", "campaign_id");

-- CreateIndex
CREATE INDEX "creative_variants_workspace_id_approval_status_idx" ON "creative_variants"("workspace_id", "approval_status");

-- AddForeignKey
ALTER TABLE "chatgpt_campaigns" ADD CONSTRAINT "chatgpt_campaigns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatgpt_campaigns" ADD CONSTRAINT "chatgpt_campaigns_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "paid_ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "chatgpt_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_variants" ADD CONSTRAINT "creative_variants_parent_variant_id_fkey" FOREIGN KEY ("parent_variant_id") REFERENCES "creative_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
