-- Funding/VC slice 1 migration (pruned to this slice's statements;
-- generated via `prisma migrate diff --from-url <live dev DB> --to-schema-datamodel`).

-- CreateEnum
CREATE TYPE "FundingContactSource" AS ENUM ('boardy_starter', 'founder_added', 'boardy_intro', 'connector_import');

-- CreateEnum
CREATE TYPE "FundingInvestorStage" AS ENUM ('target', 'contacted', 'meeting', 'diligence', 'term_sheet', 'passed');

-- CreateEnum
CREATE TYPE "FundingInteractionKind" AS ENUM ('email', 'call', 'meeting', 'intro', 'deck_sent', 'note');

-- CreateEnum
CREATE TYPE "FundingIntroStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "FundingDataRoomDocKind" AS ENUM ('pitch_deck', 'financials', 'metrics', 'other');

-- CreateEnum
CREATE TYPE "FundingRoundStatus" AS ENUM ('planning', 'active', 'paused', 'closed');

-- CreateTable
CREATE TABLE "funding_contacts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "handle" TEXT,
    "note" TEXT,
    "source" "FundingContactSource" NOT NULL DEFAULT 'founder_added',
    "is_starter_contact" BOOLEAN NOT NULL DEFAULT false,
    "starter_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "funding_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_investors" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firm" TEXT,
    "email" TEXT,
    "check_size_min" INTEGER,
    "check_size_max" INTEGER,
    "stages" TEXT[],
    "sectors" TEXT[],
    "thesis_fit" TEXT,
    "stage" "FundingInvestorStage" NOT NULL DEFAULT 'target',
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "funding_investors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_interactions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "FundingInteractionKind" NOT NULL,
    "summary" TEXT NOT NULL,
    "contact_id" TEXT,
    "investor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "funding_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_intro_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "investor_id" TEXT NOT NULL,
    "status" "FundingIntroStatus" NOT NULL DEFAULT 'draft',
    "reason" TEXT NOT NULL,
    "founder_ask" TEXT NOT NULL,
    "fit_notes" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "decline_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "funding_intro_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_data_room_docs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "FundingDataRoomDocKind" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "file_url" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "funding_data_room_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_rounds" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "FundingRoundStatus" NOT NULL DEFAULT 'planning',
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "check_size_min" INTEGER,
    "check_size_max" INTEGER,
    "stages" TEXT[],
    "sectors" TEXT[],
    "thesis_summary" TEXT,
    "target_close" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "funding_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "funding_contacts_workspace_id_source_idx" ON "funding_contacts"("workspace_id", "source");

-- CreateIndex
CREATE UNIQUE INDEX "funding_contacts_workspace_id_starter_key_key" ON "funding_contacts"("workspace_id", "starter_key");

-- CreateIndex
CREATE INDEX "funding_investors_workspace_id_stage_idx" ON "funding_investors"("workspace_id", "stage");

-- CreateIndex
CREATE INDEX "funding_interactions_workspace_id_occurred_at_idx" ON "funding_interactions"("workspace_id", "occurred_at");

-- CreateIndex
CREATE INDEX "funding_intro_requests_workspace_id_status_idx" ON "funding_intro_requests"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "funding_intro_requests_workspace_id_contact_id_investor_id_key" ON "funding_intro_requests"("workspace_id", "contact_id", "investor_id");

-- CreateIndex
CREATE INDEX "funding_data_room_docs_workspace_id_kind_idx" ON "funding_data_room_docs"("workspace_id", "kind");

-- CreateIndex
CREATE INDEX "funding_rounds_workspace_id_is_active_idx" ON "funding_rounds"("workspace_id", "is_active");

-- AddForeignKey
ALTER TABLE "funding_contacts" ADD CONSTRAINT "funding_contacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_investors" ADD CONSTRAINT "funding_investors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_interactions" ADD CONSTRAINT "funding_interactions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_interactions" ADD CONSTRAINT "funding_interactions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "funding_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_interactions" ADD CONSTRAINT "funding_interactions_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "funding_investors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_intro_requests" ADD CONSTRAINT "funding_intro_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_intro_requests" ADD CONSTRAINT "funding_intro_requests_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "funding_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_intro_requests" ADD CONSTRAINT "funding_intro_requests_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "funding_investors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_data_room_docs" ADD CONSTRAINT "funding_data_room_docs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_rounds" ADD CONSTRAINT "funding_rounds_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
