-- Legal/Compliance slice 3: Document vault (BUSINESS-OS-FEATURE-SPECS.md §4).
--
-- LegalDocument is the logical document (formation doc, contract, license,
-- EIN letter, policy, other). LegalDocumentVersion holds one uploaded file
-- per version: a new upload of the same logical document adds a version row —
-- history is never overwritten. Expiry dates are tenant-set ("tenant_set")
-- or read from the document itself ("read_from_document") — the engine never
-- guesses one. Escalation tiers (90/30/7 days, overdue) are computed at read
-- time from the CURRENT version's expiryDate; last_alerted_tier records the
-- tier the sweep already emitted so each tier fires at most once per version.

-- CreateEnum
CREATE TYPE "LegalDocumentType" AS ENUM ('formation', 'contract', 'license', 'ein_letter', 'policy', 'other');

-- CreateEnum
CREATE TYPE "LegalExpirySource" AS ENUM ('tenant_set', 'read_from_document');

-- CreateTable
CREATE TABLE "legal_documents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "doc_type" "LegalDocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "current_version_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "workspace_file_id" TEXT NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiry_date" TIMESTAMP(3),
    "expiry_source" "LegalExpirySource",
    "issuer" TEXT,
    "supersedes_version_id" TEXT,
    "last_alerted_tier" TEXT,
    "last_alerted_at" TIMESTAMP(3),

    CONSTRAINT "legal_document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "legal_document_versions_document_id_version_number_key" ON "legal_document_versions"("document_id", "version_number");

-- CreateIndex
CREATE INDEX "legal_documents_workspace_id_doc_type_idx" ON "legal_documents"("workspace_id", "doc_type");

-- CreateIndex
CREATE INDEX "legal_document_versions_workspace_file_id_idx" ON "legal_document_versions"("workspace_file_id");

-- AddForeignKey
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_document_versions" ADD CONSTRAINT "legal_document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "legal_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_document_versions" ADD CONSTRAINT "legal_document_versions_workspace_file_id_fkey" FOREIGN KEY ("workspace_file_id") REFERENCES "workspace_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_document_versions" ADD CONSTRAINT "legal_document_versions_supersedes_version_id_fkey" FOREIGN KEY ("supersedes_version_id") REFERENCES "legal_document_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "legal_document_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
