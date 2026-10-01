-- Wave 2 E-sign slice 5: legal/compliance binding + evidence vault.
-- Template -> contract-type binding; vault entries anchoring sealed artifacts
-- with retention policy and legal hold.

ALTER TABLE "esign_templates"
  ADD COLUMN "contract_type" TEXT;

CREATE TABLE "esign_vault_entries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "envelope_id" TEXT NOT NULL UNIQUE REFERENCES "esign_envelopes"("id") ON DELETE CASCADE,
  -- Integrity anchors captured at vault time.
  "sealed_pdf_hash" TEXT NOT NULL,
  "audit_head_hash" TEXT NOT NULL,
  "event_count" INTEGER NOT NULL,
  "signer_count" INTEGER NOT NULL,
  "stored_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Retention: when it passes with no legal hold, the sealed bytes may be purged.
  "retention_until" TIMESTAMPTZ,
  "legal_hold" BOOLEAN NOT NULL DEFAULT FALSE,
  "legal_hold_reason" TEXT,
  "purged_at" TIMESTAMPTZ
);

CREATE INDEX "esign_vault_entries_workspace_id_stored_at_idx"
  ON "esign_vault_entries"("workspace_id", "stored_at");
