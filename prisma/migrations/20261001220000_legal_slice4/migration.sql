-- Legal/Compliance slice 4: Change radar (BUSINESS-OS-FEATURE-SPECS.md §4).
--
-- RegulationChange is structured seed data (industry[] / jurisdiction[]
-- filters; "national" applies everywhere) for regulation changes that may
-- affect the tenant. v1 = illustrative seed feed (seed_flag), NO live
-- scraping. LegalRadarTriage is the tenant's per-change triage state
-- (reviewed / dismissed; absence of a row means "new"), unique on
-- workspace_id + change_key. Cascade deletes keep triage rows attached to
-- the workspace's life. Guardrails: changes carry a source reference and
-- never invent bill numbers, statute citations, or effective dates
-- (effective_date is null unless verified).

-- CreateEnum
CREATE TYPE "RegulationChangeCategory" AS ENUM ('privacy', 'licensing', 'tax', 'employment', 'insurance', 'safety', 'other');

-- CreateEnum
CREATE TYPE "RadarTriageStatus" AS ENUM ('reviewed', 'dismissed');

-- CreateTable
CREATE TABLE "regulation_changes" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "industries" TEXT[] NOT NULL,
    "jurisdictions" TEXT[] NOT NULL,
    "category" "RegulationChangeCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "plain_english_summary" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "effective_date" TIMESTAMP(3),
    "published_at" TIMESTAMP(3) NOT NULL,
    "seed_flag" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regulation_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "regulation_changes_key_key" ON "regulation_changes"("key");

-- CreateTable
CREATE TABLE "legal_radar_triage" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "change_key" TEXT NOT NULL,
    "status" "RadarTriageStatus" NOT NULL DEFAULT 'reviewed',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_radar_triage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "legal_radar_triage_workspace_id_change_key_key" ON "legal_radar_triage"("workspace_id", "change_key");

-- CreateIndex
CREATE INDEX "legal_radar_triage_workspace_id_status_idx" ON "legal_radar_triage"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "legal_radar_triage" ADD CONSTRAINT "legal_radar_triage_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
