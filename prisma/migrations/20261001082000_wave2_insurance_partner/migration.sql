-- Wave 2 Insurance: licensed-partner producer-of-record (Tico 2026-10-01).
-- LICENSED PARTNER model: the partner holds the licenses, Marketr provides
-- the software. Binds fail closed with PARTNER_NOT_APPOINTED unless an
-- active, appointed partner is on file for the workspace.

-- CreateEnum
CREATE TYPE "InsurancePartnerStatus" AS ENUM ('active', 'suspended', 'revoked');

-- CreateTable
CREATE TABLE "insurance_licensed_partners" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact_email" TEXT,
    "license_number" TEXT,
    "states_licensed" JSONB NOT NULL DEFAULT '[]',
    "appointment_path" "InsuranceAppointmentPath" NOT NULL,
    "status" "InsurancePartnerStatus" NOT NULL DEFAULT 'active',
    "appointed_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_licensed_partners_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insurance_licensed_partners_workspace_id_status_idx" ON "insurance_licensed_partners"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "insurance_licensed_partners" ADD CONSTRAINT "insurance_licensed_partners_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
