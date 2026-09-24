-- DropForeignKey
ALTER TABLE "billing_overage_invoices" DROP CONSTRAINT "billing_overage_invoices_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "billing_workspaces" DROP CONSTRAINT "billing_workspaces_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "connector_connections" DROP CONSTRAINT "connector_connections_connector_id_fkey";

-- DropForeignKey
ALTER TABLE "connector_connections" DROP CONSTRAINT "connector_connections_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "connector_credentials" DROP CONSTRAINT "connector_credentials_connection_id_fkey";

-- DropForeignKey
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "file_attachments" DROP CONSTRAINT "file_attachments_project_id_fkey";

-- DropForeignKey
ALTER TABLE "permission_grants" DROP CONSTRAINT "permission_grants_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "project_data_sources" DROP CONSTRAINT "project_data_sources_connection_id_fkey";

-- DropForeignKey
ALTER TABLE "project_data_sources" DROP CONSTRAINT "project_data_sources_project_id_fkey";

-- DropForeignKey
ALTER TABLE "project_settings" DROP CONSTRAINT "project_settings_project_id_fkey";

-- DropForeignKey
ALTER TABLE "project_skills" DROP CONSTRAINT "project_skills_project_id_fkey";

-- DropForeignKey
ALTER TABLE "project_skills" DROP CONSTRAINT "project_skills_skill_id_fkey";

-- DropForeignKey
ALTER TABLE "skills" DROP CONSTRAINT "skills_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "workspace_settings" DROP CONSTRAINT "workspace_settings_workspace_id_fkey";

-- AlterTable
ALTER TABLE "billing_overage_invoices" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "billing_setup_idempotency" ALTER COLUMN "applied_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "billing_workspaces" ALTER COLUMN "last_overage_invoiced_through" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "connector_connections" ALTER COLUMN "scopes" DROP DEFAULT,
ALTER COLUMN "connected_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "last_refresh_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "connector_credentials" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "connectors" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "file_attachments" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "mcp_rate_limits" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "permission_grants" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "project_data_sources" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "project_settings" ALTER COLUMN "domains" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "project_skills" ALTER COLUMN "enabled_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "scheduled_skills" ALTER COLUMN "last_run_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "next_run_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "skill_runs" ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "finished_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "approved_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "skills" ALTER COLUMN "declared_tools" DROP DEFAULT,
ALTER COLUMN "installed_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "subagent_runs" ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "finished_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "workspace_settings" ALTER COLUMN "agent_allow_list" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- CreateTable
CREATE TABLE "call_number" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'fake',
    "provider_sid" TEXT,
    "friendly_name" TEXT,
    "campaign" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_number_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "due_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "fail_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "number_id" TEXT NOT NULL,
    "external_sid" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'inbound',
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_sec" INTEGER NOT NULL DEFAULT 0,
    "recording_url" TEXT,
    "transcription" TEXT,
    "summary" TEXT,
    "lead_id" TEXT,
    "touch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_page" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "consent_given" BOOLEAN NOT NULL DEFAULT false,
    "reminders_opted_out" BOOLEAN NOT NULL DEFAULT false,
    "reminders_sent" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_number_e164_key" ON "call_number"("e164");

-- CreateIndex
CREATE INDEX "call_number_workspace_id_status_idx" ON "call_number"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "call_number_workspace_id_campaign_idx" ON "call_number"("workspace_id", "campaign");

-- CreateIndex
CREATE INDEX "reminder_workspace_id_status_due_at_idx" ON "reminder"("workspace_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "reminder_booking_id_idx" ON "reminder"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "call_external_sid_key" ON "call"("external_sid");

-- CreateIndex
CREATE INDEX "call_workspace_id_started_at_idx" ON "call"("workspace_id", "started_at");

-- CreateIndex
CREATE INDEX "call_number_id_idx" ON "call"("number_id");

-- CreateIndex
CREATE INDEX "call_workspace_id_from_idx" ON "call"("workspace_id", "from");

-- CreateIndex
CREATE INDEX "call_lead_id_idx" ON "call"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_page_slug_key" ON "booking_page"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "booking_page_token_hash_key" ON "booking_page"("token_hash");

-- CreateIndex
CREATE INDEX "booking_page_workspace_id_enabled_idx" ON "booking_page"("workspace_id", "enabled");

-- CreateIndex
CREATE INDEX "booking_workspace_id_start_at_idx" ON "booking"("workspace_id", "start_at");

-- CreateIndex
CREATE INDEX "booking_page_id_start_at_idx" ON "booking"("page_id", "start_at");

-- CreateIndex
CREATE INDEX "booking_lead_id_idx" ON "booking"("lead_id");

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_skills" ADD CONSTRAINT "project_skills_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_connections" ADD CONSTRAINT "connector_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connector_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_data_sources" ADD CONSTRAINT "project_data_sources_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_data_sources" ADD CONSTRAINT "project_data_sources_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connector_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_attachments" ADD CONSTRAINT "file_attachments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_settings" ADD CONSTRAINT "project_settings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_workspaces" ADD CONSTRAINT "billing_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_overage_invoices" ADD CONSTRAINT "billing_overage_invoices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_number" ADD CONSTRAINT "call_number_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call" ADD CONSTRAINT "call_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call" ADD CONSTRAINT "call_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "call_number"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call" ADD CONSTRAINT "call_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_page" ADD CONSTRAINT "booking_page_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "booking_page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
