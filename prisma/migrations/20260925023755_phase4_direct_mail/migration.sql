-- CreateTable
CREATE TABLE "mail_provider" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'test',
    "test_key_enc" TEXT,
    "live_key_enc" TEXT,
    "webhook_secret_enc" TEXT,
    "health" TEXT NOT NULL DEFAULT 'unconfigured',
    "health_checked_at" TIMESTAMP(3),
    "health_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_creative" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel_template" TEXT NOT NULL DEFAULT 'print',
    "format_track" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "canva_design_id" TEXT,
    "canva_export_id" TEXT,
    "pdf_url" TEXT,
    "creative_hash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "validation" JSONB,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_creative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_campaign" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider_id" TEXT,
    "creative_id" TEXT,
    "audience_source" JSONB NOT NULL,
    "piece_count" INTEGER NOT NULL DEFAULT 0,
    "verified_count" INTEGER NOT NULL DEFAULT 0,
    "quarantined_count" INTEGER NOT NULL DEFAULT 0,
    "est_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "actual_cost_cents" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "in_home_start" TIMESTAMP(3),
    "in_home_end" TIMESTAMP(3),
    "mailed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_piece" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "address_snapshot" JSONB NOT NULL,
    "verification_status" TEXT NOT NULL DEFAULT 'pending',
    "provider_piece_id" TEXT,
    "qr_slug" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "suppression_reason" TEXT,
    "cost_cents" INTEGER,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_piece_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_webhook_event" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_approval" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "creative_hash" TEXT NOT NULL,
    "piece_count" INTEGER NOT NULL,
    "max_spend_cents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approver_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eddm_order" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zips" JSONB NOT NULL,
    "routes" JSONB NOT NULL DEFAULT '[]',
    "piece_count" INTEGER NOT NULL DEFAULT 0,
    "creative_id" TEXT,
    "mailhouse" TEXT,
    "brief_pdf_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "postage_cents" INTEGER NOT NULL DEFAULT 0,
    "print_cents" INTEGER NOT NULL DEFAULT 0,
    "drop_date" TIMESTAMP(3),
    "in_home_start" TIMESTAMP(3),
    "in_home_end" TIMESTAMP(3),
    "qr_slug" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eddm_order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mail_provider_workspace_id_mode_idx" ON "mail_provider"("workspace_id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "mail_provider_workspace_id_provider_key" ON "mail_provider"("workspace_id", "provider");

-- CreateIndex
CREATE INDEX "mail_creative_workspace_id_format_track_status_idx" ON "mail_creative"("workspace_id", "format_track", "status");

-- CreateIndex
CREATE INDEX "mail_creative_workspace_id_channel_template_idx" ON "mail_creative"("workspace_id", "channel_template");

-- CreateIndex
CREATE INDEX "mail_campaign_workspace_id_status_idx" ON "mail_campaign"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "mail_piece_campaign_id_status_idx" ON "mail_piece"("campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mail_piece_qr_slug_key" ON "mail_piece"("qr_slug");

-- CreateIndex
CREATE INDEX "mail_webhook_event_provider_processed_at_idx" ON "mail_webhook_event"("provider", "processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "mail_webhook_event_provider_event_id_key" ON "mail_webhook_event"("provider", "event_id");

-- CreateIndex
CREATE INDEX "mail_approval_campaign_id_status_idx" ON "mail_approval"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "eddm_order_workspace_id_status_idx" ON "eddm_order"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "eddm_order_qr_slug_key" ON "eddm_order"("qr_slug");

-- AddForeignKey
ALTER TABLE "mail_provider" ADD CONSTRAINT "mail_provider_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_creative" ADD CONSTRAINT "mail_creative_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_campaign" ADD CONSTRAINT "mail_campaign_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_campaign" ADD CONSTRAINT "mail_campaign_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "mail_provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_campaign" ADD CONSTRAINT "mail_campaign_creative_id_fkey" FOREIGN KEY ("creative_id") REFERENCES "mail_creative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_piece" ADD CONSTRAINT "mail_piece_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "mail_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_approval" ADD CONSTRAINT "mail_approval_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "mail_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eddm_order" ADD CONSTRAINT "eddm_order_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
