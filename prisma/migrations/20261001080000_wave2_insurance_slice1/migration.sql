-- Wave 2 Insurance slice 1: policy inventory ontology (Carrier, Policy, Renewal).
-- Money red-lane domain: premiums are consequential payments; the OS never
-- holds premium funds. SPEC-INSURANCE.md §4.

-- CreateEnum
CREATE TYPE "InsuranceLineOfBusiness" AS ENUM ('gl', 'wc', 'bop', 'cyber', 'professional_liability', 'commercial_auto', 'umbrella');

-- CreateEnum
CREATE TYPE "InsurancePolicyStatus" AS ENUM ('active', 'pending_renewal', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "InsuranceAppointmentPath" AS ENUM ('direct', 'dais_market_access', 'subappointment');

-- CreateEnum
CREATE TYPE "InsuranceRemarketStatus" AS ENUM ('detected', 'remarketing', 'quoted', 'bound', 'auto_renew_surfaced');

-- CreateTable
CREATE TABLE "insurance_carriers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "am_best_rating" TEXT,
    "naic_code" TEXT,
    "appointment_path" "InsuranceAppointmentPath" NOT NULL,
    "lines_supported" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_carriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_policies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "carrier_id" TEXT NOT NULL,
    "policy_number" TEXT NOT NULL,
    "line" "InsuranceLineOfBusiness" NOT NULL,
    "named_insured" TEXT NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "limit_per_occurrence_cents" INTEGER,
    "limit_aggregate_cents" INTEGER,
    "deductible_cents" INTEGER,
    "annual_premium_cents" INTEGER,
    "payment_schedule" TEXT,
    "status" "InsurancePolicyStatus" NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "prior_policy_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_renewals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "renewal_date" TIMESTAMP(3) NOT NULL,
    "remarket_status" "InsuranceRemarketStatus" NOT NULL DEFAULT 'detected',
    "prior_premium_cents" INTEGER,
    "new_premium_cents" INTEGER,
    "premium_delta_pct" DOUBLE PRECISION,
    "alert_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_renewals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "insurance_carriers_workspace_id_name_key" ON "insurance_carriers"("workspace_id", "name");
CREATE INDEX "insurance_carriers_workspace_id_idx" ON "insurance_carriers"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_policies_workspace_id_policy_number_key" ON "insurance_policies"("workspace_id", "policy_number");
CREATE INDEX "insurance_policies_workspace_id_status_idx" ON "insurance_policies"("workspace_id", "status");
CREATE INDEX "insurance_policies_workspace_id_expires_at_idx" ON "insurance_policies"("workspace_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_renewals_workspace_id_policy_id_renewal_date_key" ON "insurance_renewals"("workspace_id", "policy_id", "renewal_date");
CREATE INDEX "insurance_renewals_workspace_id_renewal_date_idx" ON "insurance_renewals"("workspace_id", "renewal_date");
CREATE INDEX "insurance_renewals_workspace_id_remarket_status_idx" ON "insurance_renewals"("workspace_id", "remarket_status");

-- AddForeignKey
ALTER TABLE "insurance_carriers" ADD CONSTRAINT "insurance_carriers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "insurance_carriers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_prior_policy_id_fkey" FOREIGN KEY ("prior_policy_id") REFERENCES "insurance_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_renewals" ADD CONSTRAINT "insurance_renewals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_renewals" ADD CONSTRAINT "insurance_renewals_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
