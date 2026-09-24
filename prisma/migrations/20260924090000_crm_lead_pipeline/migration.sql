-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('website_form', 'phone', 'referral', 'import', 'ad', 'ooh', 'direct_mail', 'other');

-- CreateEnum
CREATE TYPE "LeadActivityType" AS ENUM ('created', 'note', 'email', 'call', 'sms', 'meeting', 'stage_change', 'score_change', 'form_submit', 'import');

-- CreateTable
CREATE TABLE "crm_pipelines" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "client_id" TEXT,
    "name" TEXT NOT NULL,
    "stages" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_leads" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "company" TEXT,
    "title" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'other',
    "source_detail" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "score" INTEGER NOT NULL DEFAULT 0,
    "value_cents" INTEGER,
    "owner_id" TEXT,
    "owner_name" TEXT,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "custom_fields" JSONB,
    "dedup_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_lead_activities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "type" "LeadActivityType" NOT NULL,
    "body" TEXT,
    "actor" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_capture_forms" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fields" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_capture_forms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_pipelines_workspace_id_idx" ON "crm_pipelines"("workspace_id");

-- CreateIndex
CREATE INDEX "crm_leads_workspace_id_pipeline_id_stage_idx" ON "crm_leads"("workspace_id", "pipeline_id", "stage");

-- CreateIndex
CREATE INDEX "crm_leads_workspace_id_score_idx" ON "crm_leads"("workspace_id", "score");

-- CreateIndex
CREATE UNIQUE INDEX "crm_leads_workspace_id_dedup_key_key" ON "crm_leads"("workspace_id", "dedup_key");

-- CreateIndex
CREATE INDEX "crm_lead_activities_lead_id_created_at_idx" ON "crm_lead_activities"("lead_id", "created_at");

-- CreateIndex
CREATE INDEX "crm_lead_activities_workspace_id_created_at_idx" ON "crm_lead_activities"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_capture_forms_token_hash_key" ON "crm_capture_forms"("token_hash");

-- CreateIndex
CREATE INDEX "crm_capture_forms_pipeline_id_idx" ON "crm_capture_forms"("pipeline_id");

-- AddForeignKey
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "crm_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_lead_activities" ADD CONSTRAINT "crm_lead_activities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_lead_activities" ADD CONSTRAINT "crm_lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_capture_forms" ADD CONSTRAINT "crm_capture_forms_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_capture_forms" ADD CONSTRAINT "crm_capture_forms_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "crm_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
