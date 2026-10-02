-- Funding/VC slice 2 migration: Investor CRM (pruned to this slice's statements;
-- generated via `prisma migrate diff --from-url <live dev DB> --to-schema-datamodel`).
-- Pre-existing schema<->DB drift (WFH enums, regulation_changes,
-- legal_radar_triage, timestamp-type noise, FileChangeAction churn) deliberately
-- left untouched.

-- CreateEnum
CREATE TYPE "FundingEnrichmentSource" AS ENUM ('self_reported', 'enriched');

-- AlterEnum
ALTER TYPE "FundingInteractionKind" ADD VALUE 'stage_change';

-- AlterEnum (two values; psql runs them as separate statements)
ALTER TYPE "FundingInvestorStage" ADD VALUE 'won';
ALTER TYPE "FundingInvestorStage" ADD VALUE 'lost';

-- AlterTable
ALTER TABLE "funding_interactions" ADD COLUMN "actor" TEXT;

-- AlterTable
ALTER TABLE "funding_investors" ADD COLUMN "enrichment_fetched_at" TIMESTAMP(3),
ADD COLUMN "enrichment_notes" TEXT,
ADD COLUMN "enrichment_source" "FundingEnrichmentSource" NOT NULL DEFAULT 'self_reported',
ADD COLUMN "title" TEXT;

-- CreateTable
CREATE TABLE "funding_follow_ups" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "investor_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "done_at" TIMESTAMP(3),
    "last_alerted_tier" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "funding_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "funding_follow_ups_workspace_id_done_due_at_idx" ON "funding_follow_ups"("workspace_id", "done", "due_at");

-- CreateIndex
CREATE INDEX "funding_follow_ups_investor_id_idx" ON "funding_follow_ups"("investor_id");

-- AddForeignKey
ALTER TABLE "funding_follow_ups" ADD CONSTRAINT "funding_follow_ups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_follow_ups" ADD CONSTRAINT "funding_follow_ups_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "funding_investors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
