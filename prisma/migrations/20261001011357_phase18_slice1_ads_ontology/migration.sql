-- Phase 18 slice 1: ad-platforms ontology (AdPlatform, AdAccount, PaidAdCampaign/Group/Creative, SpendProposal, SpendApproval, AdReport)

-- CreateEnum
CREATE TYPE "AdPlatformKey" AS ENUM ('amazon', 'stackadapt', 'walmart', 'spotify');

-- CreateEnum
CREATE TYPE "AdPlatformAuthKind" AS ENUM ('oauth', 'api_key', 'guided');

-- CreateEnum
CREATE TYPE "AdAccountStatus" AS ENUM ('pending', 'connected', 'expired', 'revoked', 'error');

-- CreateEnum
CREATE TYPE "PaidAdStatus" AS ENUM ('draft', 'proposed', 'live', 'paused', 'ended');

-- CreateEnum
CREATE TYPE "SpendProposalKind" AS ENUM ('launch', 'pause', 'budget_change', 'new_flight');

-- CreateEnum
CREATE TYPE "SpendProposalStatus" AS ENUM ('pending', 'approved', 'rejected', 'executed', 'expired');

-- CreateTable
CREATE TABLE "ad_platforms" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "key" "AdPlatformKey" NOT NULL,
    "display_name" TEXT NOT NULL,
    "auth_kind" "AdPlatformAuthKind" NOT NULL,
    "supports_api_launch" BOOLEAN NOT NULL DEFAULT false,
    "supports_reporting_api" BOOLEAN NOT NULL DEFAULT false,
    "guided_only" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_platforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_accounts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,
    "name" TEXT,
    "external_account_id" TEXT NOT NULL,
    "token_ref" TEXT,
    "status" "AdAccountStatus" NOT NULL DEFAULT 'pending',
    "sub_account_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paid_ad_campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "platform_key" "AdPlatformKey" NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "external_id" TEXT,
    "status" "PaidAdStatus" NOT NULL DEFAULT 'draft',
    "budget_cents" INTEGER,
    "flight_start" TIMESTAMP(3),
    "flight_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paid_ad_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paid_ad_groups" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "external_id" TEXT,
    "status" "PaidAdStatus" NOT NULL DEFAULT 'draft',
    "budget_cents" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paid_ad_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paid_ad_creatives" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "external_id" TEXT,
    "asset_refs" JSONB NOT NULL DEFAULT '[]',
    "platform_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paid_ad_creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spend_proposals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" "SpendProposalKind" NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "scope_hash" TEXT NOT NULL,
    "status" "SpendProposalStatus" NOT NULL DEFAULT 'pending',
    "proposed_by" TEXT NOT NULL,
    "proposed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spend_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spend_approvals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "approver" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scope_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spend_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_reports" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "spend_cents" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "ctr" DOUBLE PRECISION,
    "conversions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "revenue_cents" INTEGER NOT NULL DEFAULT 0,
    "approval_id" TEXT,
    "platform_receipt_id" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ad_platforms_workspace_id_key_key" ON "ad_platforms"("workspace_id", "key");

-- CreateIndex
CREATE INDEX "ad_accounts_workspace_id_status_idx" ON "ad_accounts"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ad_accounts_workspace_id_platform_id_external_account_id_key" ON "ad_accounts"("workspace_id", "platform_id", "external_account_id");

-- CreateIndex
CREATE INDEX "paid_ad_campaigns_workspace_id_status_idx" ON "paid_ad_campaigns"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "paid_ad_campaigns_workspace_id_platform_key_idx" ON "paid_ad_campaigns"("workspace_id", "platform_key");

-- CreateIndex
CREATE UNIQUE INDEX "paid_ad_campaigns_workspace_id_account_id_external_id_key" ON "paid_ad_campaigns"("workspace_id", "account_id", "external_id");

-- CreateIndex
CREATE INDEX "paid_ad_groups_workspace_id_campaign_id_idx" ON "paid_ad_groups"("workspace_id", "campaign_id");

-- CreateIndex
CREATE INDEX "paid_ad_creatives_workspace_id_group_id_idx" ON "paid_ad_creatives"("workspace_id", "group_id");

-- CreateIndex
CREATE INDEX "spend_proposals_workspace_id_status_idx" ON "spend_proposals"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "spend_proposals_workspace_id_target_type_target_id_idx" ON "spend_proposals"("workspace_id", "target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "spend_approvals_proposal_id_key" ON "spend_approvals"("proposal_id");

-- CreateIndex
CREATE INDEX "spend_approvals_workspace_id_approver_idx" ON "spend_approvals"("workspace_id", "approver");

-- CreateIndex
CREATE INDEX "ad_reports_workspace_id_date_idx" ON "ad_reports"("workspace_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_reports_workspace_id_campaign_id_date_key" ON "ad_reports"("workspace_id", "campaign_id", "date");

-- AddForeignKey
ALTER TABLE "ad_platforms" ADD CONSTRAINT "ad_platforms_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "ad_platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paid_ad_campaigns" ADD CONSTRAINT "paid_ad_campaigns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paid_ad_campaigns" ADD CONSTRAINT "paid_ad_campaigns_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paid_ad_groups" ADD CONSTRAINT "paid_ad_groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paid_ad_groups" ADD CONSTRAINT "paid_ad_groups_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "paid_ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paid_ad_creatives" ADD CONSTRAINT "paid_ad_creatives_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paid_ad_creatives" ADD CONSTRAINT "paid_ad_creatives_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "paid_ad_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spend_proposals" ADD CONSTRAINT "spend_proposals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spend_approvals" ADD CONSTRAINT "spend_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spend_approvals" ADD CONSTRAINT "spend_approvals_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "spend_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_reports" ADD CONSTRAINT "ad_reports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_reports" ADD CONSTRAINT "ad_reports_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_reports" ADD CONSTRAINT "ad_reports_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "paid_ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
