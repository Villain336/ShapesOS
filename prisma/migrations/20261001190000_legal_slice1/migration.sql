-- Legal/Compliance slice 1: Obligation map (BUSINESS-OS-FEATURE-SPECS.md §4).
--
-- LegalProfile captures industry + business model + jurisdictions per tenant
-- (one row per workspace). ObligationTemplate is structured seed data with
-- industry[] / jurisdiction[] filters ("national" applies everywhere).
-- Obligation is the per-tenant computed instance (unique on
-- workspace_id + template_key) carrying tenant-controlled status, snooze,
-- and dismiss state. Cascade deletes keep all three tables attached to the
-- workspace's life.

-- CreateEnum
CREATE TYPE "ObligationCategory" AS ENUM ('license', 'filing', 'tax', 'insurance', 'permit');

-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('open', 'snoozed', 'dismissed', 'done');

-- CreateTable
CREATE TABLE "legal_profiles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "business_model" TEXT NOT NULL,
    "jurisdictions" TEXT[] NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "legal_profiles_workspace_id_key" ON "legal_profiles"("workspace_id");

-- AddForeignKey
ALTER TABLE "legal_profiles" ADD CONSTRAINT "legal_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "obligation_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "industries" TEXT[] NOT NULL,
    "jurisdictions" TEXT[] NOT NULL,
    "category" "ObligationCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "renewal_cadence" TEXT,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "obligation_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "obligation_templates_key_key" ON "obligation_templates"("key");

-- CreateTable
CREATE TABLE "obligations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "template_key" TEXT NOT NULL,
    "status" "ObligationStatus" NOT NULL DEFAULT 'open',
    "snoozed_until" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "obligations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "obligations_workspace_id_template_key_key" ON "obligations"("workspace_id", "template_key");
CREATE INDEX "obligations_workspace_id_status_idx" ON "obligations"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
