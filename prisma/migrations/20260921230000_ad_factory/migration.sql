-- Marketr milestone 21: Higgsfield-powered ad factory.
-- (Hand-written — no PostgreSQL in sandbox; review before deploy.)

-- New enums
CREATE TYPE "AdCreativeType" AS ENUM ('image', 'video');
CREATE TYPE "AdCreativeStatus" AS ENUM ('queued', 'generating', 'ready', 'failed', 'cancelled');

-- Audit enum additions
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_campaign_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_campaign_updated';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_campaign_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_higgsfield_key_updated';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_higgsfield_key_revoked';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_generation_started';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_generation_completed';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_generation_failed';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_creative_approved';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_creative_rejected';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_creative_regenerated';
ALTER TYPE "FileChangeAction" ADD VALUE 'ad_sent_to_social';

-- Workspace ad settings (BYO Higgsfield API key, encrypted; monthly spend cap)
CREATE TABLE "ad_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "higgsfield_key_enc" TEXT,
    "higgsfield_key_hint" TEXT,
    "monthly_cap_cents" INTEGER NOT NULL DEFAULT 5000,
    "spend_cents" INTEGER NOT NULL DEFAULT 0,
    "spend_period" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ad_settings_workspace_id_key" ON "ad_settings"("workspace_id");

-- Ad campaigns per project
CREATE TABLE "ad_campaigns" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "brand_kit_id" TEXT,
    "channels" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ad_campaigns_project_id_idx" ON "ad_campaigns"("project_id");

-- Ad creatives (one row = one generation job)
CREATE TABLE "ad_creatives" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AdCreativeType" NOT NULL,
    "brief" JSONB NOT NULL,
    "prompt" TEXT NOT NULL,
    "prompt_history" JSONB NOT NULL DEFAULT '[]',
    "status" "AdCreativeStatus" NOT NULL DEFAULT 'queued',
    "aspect_ratio" TEXT NOT NULL DEFAULT '1:1',
    "channels" JSONB NOT NULL DEFAULT '[]',
    "cost_estimate_cents" INTEGER NOT NULL DEFAULT 0,
    "cost_actual_cents" INTEGER NOT NULL DEFAULT 0,
    "assets" JSONB NOT NULL DEFAULT '[]',
    "provider_job_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_poll_at" TIMESTAMP(3),
    "error" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "rejected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_creatives_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ad_creatives_campaign_id_status_idx" ON "ad_creatives"("campaign_id", "status");
CREATE INDEX "ad_creatives_status_next_poll_at_idx" ON "ad_creatives"("status", "next_poll_at");
