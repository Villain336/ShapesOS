-- Legal/Compliance slice 5: Digital-properties module — Hullcheck synergy
-- (BUSINESS-OS-FEATURE-SPECS.md §4).
--
-- LegalDigitalProperty is the tenant's registry of digital properties
-- (website | app): name, optional URL, kind, notes. LegalDigitalFinding is
-- one plain-English finding against a property, organized by Hullcheck's
-- layer taxonomy (detect | fix | prove | harden | document | comply).
-- Findings carry the plain-English "what this means for your business"
-- summary (never empty), a severity, a status (open | fixed | dismissed),
-- an always-labeled source (self_assessment | manual_import |
-- hullcheck_engine — the engine source is reserved for the future scan
-- engine), and an optional obligationKey linking into slice 1's obligation
-- templates. Guardrails: findings are informational only (see the
-- LEGAL_DISCLAIMER on every output); v1 findings come from the tenant's own
-- self-assessment or manual import — nothing is invented by a scan.

-- CreateEnum
CREATE TYPE "DigitalPropertyKind" AS ENUM ('website', 'app');

-- CreateEnum
CREATE TYPE "HullcheckLayer" AS ENUM ('detect', 'fix', 'prove', 'harden', 'document', 'comply');

-- CreateEnum
CREATE TYPE "DigitalFindingSeverity" AS ENUM ('critical', 'high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "DigitalFindingStatus" AS ENUM ('open', 'fixed', 'dismissed');

-- CreateEnum
CREATE TYPE "DigitalFindingSource" AS ENUM ('self_assessment', 'manual_import', 'hullcheck_engine');

-- CreateTable
CREATE TABLE "legal_digital_properties" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "kind" "DigitalPropertyKind" NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_digital_properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_digital_findings" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "item_key" TEXT,
    "hullcheck_layer" "HullcheckLayer" NOT NULL,
    "title" TEXT NOT NULL,
    "plain_english_summary" TEXT NOT NULL,
    "severity" "DigitalFindingSeverity" NOT NULL,
    "status" "DigitalFindingStatus" NOT NULL DEFAULT 'open',
    "source" "DigitalFindingSource" NOT NULL,
    "obligation_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_digital_findings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "legal_digital_properties" ADD CONSTRAINT "legal_digital_properties_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_digital_findings" ADD CONSTRAINT "legal_digital_findings_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "legal_digital_properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "legal_digital_properties_workspace_id_idx" ON "legal_digital_properties"("workspace_id");

-- CreateIndex
CREATE INDEX "legal_digital_findings_property_id_status_idx" ON "legal_digital_findings"("property_id", "status");
