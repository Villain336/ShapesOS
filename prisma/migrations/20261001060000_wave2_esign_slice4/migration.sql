-- Wave 2 E-sign slice 4: template source-document bytes.
-- A SigningTemplate is a reusable envelope blueprint; the blueprint PDF is
-- stored so instantiateTemplate can mint byte-identical drafts.

ALTER TABLE "esign_templates"
  ADD COLUMN "source_document" BYTEA,
  ADD COLUMN "source_document_hash" TEXT,
  ADD COLUMN "source_document_size" INTEGER;
