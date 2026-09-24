-- Phase 3 — acquisition loop (R3 nurture, R4 review engine, R6 prospecting).

-- CreateTable
CREATE TABLE "contact_consent" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "source" TEXT,
    "consented_at" TIMESTAMP(3),
    "opted_out_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_message" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "kind" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "suppression_reason" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'fake',
    "provider_sid" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "error" TEXT,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "approval_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_item" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nurture_sequence" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approval_policy" TEXT NOT NULL DEFAULT 'manual',
    "daily_cap" INTEGER,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nurture_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_enrollment" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "sequence_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_request" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "review_url" TEXT,
    "message_id" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "review_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_site_config" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "site" TEXT NOT NULL DEFAULT 'google',
    "review_url" TEXT NOT NULL,
    "delay_days" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_site_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_list" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icp" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "company" TEXT,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "website" TEXT,
    "enrichment_data" JSONB,
    "research" JSONB,
    "status" TEXT NOT NULL DEFAULT 'new',
    "score" INTEGER NOT NULL DEFAULT 0,
    "lead_id" TEXT,
    "dedup_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_lookup" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "prospect_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrichment_lookup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contact_consent_workspace_id_lead_id_channel_key" ON "contact_consent"("workspace_id", "lead_id", "channel");

-- CreateIndex
CREATE INDEX "contact_consent_workspace_id_channel_status_idx" ON "contact_consent"("workspace_id", "channel", "status");

-- CreateIndex
CREATE INDEX "outbound_message_workspace_id_lead_id_created_at_idx" ON "outbound_message"("workspace_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "outbound_message_workspace_id_status_scheduled_for_idx" ON "outbound_message"("workspace_id", "status", "scheduled_for");

-- CreateIndex
CREATE INDEX "approval_item_workspace_id_status_created_at_idx" ON "approval_item"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "nurture_sequence_workspace_id_status_idx" ON "nurture_sequence"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_enrollment_sequence_id_lead_id_key" ON "sequence_enrollment"("sequence_id", "lead_id");

-- CreateIndex
CREATE INDEX "sequence_enrollment_workspace_id_status_next_run_at_idx" ON "sequence_enrollment"("workspace_id", "status", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "review_request_token_key" ON "review_request"("token");

-- CreateIndex
CREATE INDEX "review_request_workspace_id_status_idx" ON "review_request"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "review_site_config_workspace_id_site_key" ON "review_site_config"("workspace_id", "site");

-- CreateIndex
CREATE INDEX "prospect_list_workspace_id_status_idx" ON "prospect_list"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_workspace_id_dedup_key_key" ON "prospect"("workspace_id", "dedup_key");

-- CreateIndex
CREATE INDEX "prospect_list_id_status_idx" ON "prospect"("list_id", "status");

-- CreateIndex
CREATE INDEX "enrichment_lookup_prospect_id_created_at_idx" ON "enrichment_lookup"("prospect_id", "created_at");

-- CreateIndex
CREATE INDEX "enrichment_lookup_workspace_id_created_at_idx" ON "enrichment_lookup"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "contact_consent" ADD CONSTRAINT "contact_consent_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_consent" ADD CONSTRAINT "contact_consent_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_item" ADD CONSTRAINT "approval_item_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurture_sequence" ADD CONSTRAINT "nurture_sequence_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "nurture_sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_enrollment" ADD CONSTRAINT "sequence_enrollment_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_request" ADD CONSTRAINT "review_request_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_request" ADD CONSTRAINT "review_request_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_site_config" ADD CONSTRAINT "review_site_config_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_list" ADD CONSTRAINT "prospect_list_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect" ADD CONSTRAINT "prospect_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect" ADD CONSTRAINT "prospect_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "prospect_list"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect" ADD CONSTRAINT "prospect_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_lookup" ADD CONSTRAINT "enrichment_lookup_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrichment_lookup" ADD CONSTRAINT "enrichment_lookup_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
