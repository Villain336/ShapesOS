-- Wave 2 Insurance slice 2: quoting ontology (Submission, Quote).
-- Declines and referrals are first-class outcomes with documented reasons.

-- CreateEnum
CREATE TYPE "InsuranceSubmissionStatus" AS ENUM ('draft', 'submitted', 'quoted', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "InsuranceQuoteStatus" AS ENUM ('draft', 'quoted', 'declined', 'referred', 'expired', 'bound');

-- CreateTable
CREATE TABLE "insurance_submissions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "line" "InsuranceLineOfBusiness" NOT NULL,
    "applicant_name" TEXT NOT NULL,
    "operations_description" TEXT,
    "state" TEXT NOT NULL,
    "class_code" TEXT,
    "payroll_cents" INTEGER,
    "revenue_cents" INTEGER,
    "target_limit_per_occurrence_cents" INTEGER,
    "target_limit_aggregate_cents" INTEGER,
    "loss_history" JSONB NOT NULL DEFAULT '[]',
    "status" "InsuranceSubmissionStatus" NOT NULL DEFAULT 'draft',
    "vendor_ref" TEXT,
    "submitted_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_quotes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "carrier_name" TEXT NOT NULL,
    "quoted_premium_cents" INTEGER,
    "limit_per_occurrence_cents" INTEGER,
    "limit_aggregate_cents" INTEGER,
    "quote_expiry" TIMESTAMP(3),
    "status" "InsuranceQuoteStatus" NOT NULL DEFAULT 'draft',
    "vendor_notes" TEXT,
    "raw_payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insurance_submissions_workspace_id_status_idx" ON "insurance_submissions"("workspace_id", "status");
CREATE INDEX "insurance_quotes_workspace_id_submission_id_idx" ON "insurance_quotes"("workspace_id", "submission_id");
CREATE INDEX "insurance_quotes_workspace_id_status_idx" ON "insurance_quotes"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "insurance_submissions" ADD CONSTRAINT "insurance_submissions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "insurance_quotes" ADD CONSTRAINT "insurance_quotes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "insurance_quotes" ADD CONSTRAINT "insurance_quotes_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "insurance_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
