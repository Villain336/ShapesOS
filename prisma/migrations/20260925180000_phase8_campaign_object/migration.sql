-- CreateEnum
CREATE TYPE "GrowthCampaignObjective" AS ENUM ('lead_gen', 'sale', 'awareness', 'retention', 'launch');

-- CreateEnum
CREATE TYPE "GrowthCampaignStatus" AS ENUM ('draft', 'active', 'paused', 'complete', 'archived');

-- CreateEnum
CREATE TYPE "CampaignLinkedType" AS ENUM ('mail_campaign', 'outreach_campaign', 'media_buy', 'ctv_campaign', 'newsletter_broadcast', 'social_post', 'experiment', 'recycling_brief');

-- CreateEnum
CREATE TYPE "CampaignLinkRole" AS ENUM ('primary', 'supporting');

-- CreateEnum
CREATE TYPE "CampaignLinkSource" AS ENUM ('human', 'naming_convention', 'utm', 'api');

-- CreateEnum
CREATE TYPE "LinkProposalStatus" AS ENUM ('pending', 'approved', 'rejected');


-- CreateEnum
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "FileChangeAction" ADD VALUE 'campaign_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'campaign_updated';
ALTER TYPE "FileChangeAction" ADD VALUE 'campaign_archived';
ALTER TYPE "FileChangeAction" ADD VALUE 'campaign_link_attached';
ALTER TYPE "FileChangeAction" ADD VALUE 'campaign_link_detached';
ALTER TYPE "FileChangeAction" ADD VALUE 'link_proposal_resolved';
-- CreateTable
CREATE TABLE "growth_campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" "GrowthCampaignObjective" NOT NULL,
    "status" "GrowthCampaignStatus" NOT NULL DEFAULT 'draft',
    "stages" JSONB NOT NULL DEFAULT '[]',
    "budget_rollup_cents" INTEGER NOT NULL DEFAULT 0,
    "reporting_config" JSONB NOT NULL DEFAULT '{}',
    "parent_campaign_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "growth_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_links" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "linked_type" "CampaignLinkedType" NOT NULL,
    "linked_id" TEXT NOT NULL,
    "role" "CampaignLinkRole" NOT NULL DEFAULT 'primary',
    "link_source" "CampaignLinkSource" NOT NULL DEFAULT 'human',
    "platform_ref" JSONB,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linked_by" TEXT,

    CONSTRAINT "campaign_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_link_proposals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "linked_type" "CampaignLinkedType" NOT NULL,
    "linked_id" TEXT NOT NULL,
    "match_signals" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "LinkProposalStatus" NOT NULL DEFAULT 'pending',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_link_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "growth_campaigns_workspace_id_status_idx" ON "growth_campaigns"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "growth_campaigns_parent_campaign_id_idx" ON "growth_campaigns"("parent_campaign_id");

-- CreateIndex
CREATE INDEX "campaign_links_campaign_id_idx" ON "campaign_links"("campaign_id");

-- CreateIndex
CREATE INDEX "campaign_links_linked_type_linked_id_idx" ON "campaign_links"("linked_type", "linked_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_links_campaign_id_linked_type_linked_id_key" ON "campaign_links"("campaign_id", "linked_type", "linked_id");

-- CreateIndex
CREATE INDEX "campaign_link_proposals_workspace_id_status_idx" ON "campaign_link_proposals"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "campaign_link_proposals_workspace_id_linked_type_linked_id_idx" ON "campaign_link_proposals"("workspace_id", "linked_type", "linked_id");

ALTER TABLE "growth_campaigns" ADD CONSTRAINT "growth_campaigns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "growth_campaigns" ADD CONSTRAINT "growth_campaigns_parent_campaign_id_fkey" FOREIGN KEY ("parent_campaign_id") REFERENCES "growth_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_links" ADD CONSTRAINT "campaign_links_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "growth_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_link_proposals" ADD CONSTRAINT "campaign_link_proposals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_link_proposals" ADD CONSTRAINT "campaign_link_proposals_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "growth_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey

-- ============================================================
-- Phase 8 G2 RLS (spec §4, §9.2): tenant isolation enforced at the
-- database level, mirroring the G1 convention (same `app.workspace_id`
-- GUC, same FORCE semantics). Every table carries workspace_id (direct
-- on growth_campaigns and campaign_link_proposals; derived via the
-- parent campaign on campaign_links).
--
-- FORCE so the table owner is also constrained. Sessions that do NOT set
-- the GUC see ZERO rows (fail-closed). lib/substrate/campaigns/rls.ts
-- `withCampaignScope()` sets `app.workspace_id` per transaction before
-- touching these tables. Migration/deploy tooling must SET
-- app.workspace_id before touching these tables.
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'growth_campaigns', 'campaign_link_proposals'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t
    );
  END LOOP;
END $$;

-- campaign_links has no workspace_id column by design (spec §4); its tenant
-- scope is derived from the parent growth_campaign row. The policy
-- subquery's growth_campaigns lookup is itself RLS-gated (same GUC), so
-- the isolation composes transitively.
ALTER TABLE "campaign_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "campaign_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY campaign_links_tenant_isolation ON "campaign_links" FOR ALL
  USING (EXISTS (
    SELECT 1 FROM "growth_campaigns" gc
    WHERE gc."id" = "campaign_links"."campaign_id"
      AND gc."workspace_id" = current_setting('app.workspace_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "growth_campaigns" gc
    WHERE gc."id" = "campaign_links"."campaign_id"
      AND gc."workspace_id" = current_setting('app.workspace_id', true)
  ));
