-- Wave 2 E-sign module, slice 2: store the draft's source PDF on the envelope
-- so the heavy-gated send can create the vendor document from the exact
-- bytes the approver reviewed (confirmation token binds to the PDF hash).

ALTER TABLE "esign_envelopes" ADD COLUMN "source_pdf" BYTEA;
ALTER TABLE "esign_envelopes" ADD COLUMN "source_pdf_hash" TEXT;
