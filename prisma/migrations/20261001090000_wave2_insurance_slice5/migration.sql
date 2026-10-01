-- Wave 2 Insurance slice 5: COI (certificate of insurance) pipeline
-- (SPEC-INSURANCE.md §4.1, §4.3, §5 — final Thread-1 slice).
--
-- InsuranceCertificate: a certificate of insurance rendered ONLY from the
-- in-force issuing policy's truth. Lifecycle: draft (agent-prepared, human
-- review via the issue_certificate governed action) → issued (PDF artifact
-- generated from the verified payload, bytes + sha256 stored) → revoked
-- (with reason + audit event). Never from drafts or quotes; unverified
-- fields render "not confirmed". pdfBytes/pg serve pattern mirrors the
-- e-sign sealed evidence (app/api/esign/envelopes/[id]/evidence/pdf).

-- CreateEnum
CREATE TYPE "InsuranceCertificateStatus" AS ENUM ('draft', 'issued', 'revoked');

-- CreateTable
CREATE TABLE "insurance_certificates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "holder_name" TEXT NOT NULL,
    "holder_address" TEXT,
    "additional_insured" BOOLEAN NOT NULL DEFAULT false,
    "waiver_of_subrogation" BOOLEAN NOT NULL DEFAULT false,
    "operations_description" TEXT,
    "issue_date" TIMESTAMP(3) NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "pdf_bytes" BYTEA,
    "pdf_hash" TEXT,
    "status" "InsuranceCertificateStatus" NOT NULL DEFAULT 'draft',
    "requested_by" TEXT,
    "requested_for" TEXT,
    "issued_by" TEXT,
    "issued_at" TIMESTAMP(3),
    "approval_id" TEXT,
    "revoked_reason" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insurance_certificates_workspace_id_status_idx" ON "insurance_certificates"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "insurance_certificates" ADD CONSTRAINT "insurance_certificates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_certificates" ADD CONSTRAINT "insurance_certificates_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
