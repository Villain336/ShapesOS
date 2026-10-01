-- Wave 2 Insurance slice 4: renewal remarketing workflow
-- (SPEC-INSURANCE.md §4.3 — renew governed action).
--
-- InsuranceRenewal.autoRenewTerms: the carrier's auto-renewal terms snapshot.
-- Auto-renewals are detected and surfaced, NEVER silently accepted — the
-- snapshot plus premium/coverage delta flags go to human review before any
-- renewal approval.
--
-- InsuranceSubmission.renewalId: links a remarket submission back to the
-- renewal it was created for (startRemarket pre-fills it from the expiring
-- policy). Null for ordinary new-business submissions.

-- AlterTable
ALTER TABLE "insurance_renewals" ADD COLUMN "auto_renew_terms" JSONB;

-- AlterTable
ALTER TABLE "insurance_submissions" ADD COLUMN "renewal_id" TEXT;

-- AddForeignKey
ALTER TABLE "insurance_submissions" ADD CONSTRAINT "insurance_submissions_renewal_id_fkey" FOREIGN KEY ("renewal_id") REFERENCES "insurance_renewals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "insurance_submissions_workspace_id_renewal_id_idx" ON "insurance_submissions"("workspace_id", "renewal_id");
