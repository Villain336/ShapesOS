-- Wave 2 quick wins — E-sign module, slice 1 (SPEC-GAP-ESIGN.md).
-- Envelope ontology: envelopes, signers, fields, templates, hash-chained audit events.

CREATE TABLE "esign_templates" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "source_document_name" TEXT,
  "field_layout" JSONB NOT NULL DEFAULT '[]',
  "signer_roles" JSONB NOT NULL DEFAULT '[]',
  "merge_field_mapping" JSONB NOT NULL DEFAULT '{}',
  "owner_user_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "esign_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "esign_templates_workspace_id_updated_at_idx" ON "esign_templates"("workspace_id", "updated_at");

CREATE TABLE "esign_envelopes" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "signing_order" TEXT NOT NULL DEFAULT 'sequential',
  "vendor" TEXT NOT NULL DEFAULT 'documenso',
  "vendor_ref" TEXT,
  "vendor_status" TEXT,
  "document_name" TEXT,
  "document_size" INTEGER,
  "sealed_pdf" BYTEA,
  "sealed_pdf_hash" TEXT,
  "sealed_pdf_fetched_at" TIMESTAMPTZ(6),
  "contract_type" TEXT,
  "contract_ref" TEXT,
  "pipeline_ref" JSONB,
  "template_id" TEXT,
  "expires_at" TIMESTAMPTZ(6),
  "void_reason" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "esign_envelopes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "esign_envelopes_workspace_id_updated_at_idx" ON "esign_envelopes"("workspace_id", "updated_at");
CREATE INDEX "esign_envelopes_workspace_id_status_idx" ON "esign_envelopes"("workspace_id", "status");
CREATE INDEX "esign_envelopes_vendor_ref_idx" ON "esign_envelopes"("vendor_ref");
ALTER TABLE "esign_envelopes" ADD CONSTRAINT "esign_envelopes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "esign_envelopes" ADD CONSTRAINT "esign_envelopes_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "esign_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "esign_templates" ADD CONSTRAINT "esign_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "esign_signers" (
  "id" TEXT NOT NULL,
  "envelope_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'signer',
  "order_index" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "signed_at" TIMESTAMPTZ(6),
  "identity_evidence" JSONB,
  CONSTRAINT "esign_signers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "esign_signers_envelope_id_order_index_idx" ON "esign_signers"("envelope_id", "order_index");
ALTER TABLE "esign_signers" ADD CONSTRAINT "esign_signers_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "esign_envelopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "esign_fields" (
  "id" TEXT NOT NULL,
  "envelope_id" TEXT NOT NULL,
  "signer_id" TEXT,
  "field_type" TEXT NOT NULL,
  "page" INTEGER NOT NULL DEFAULT 1,
  "x" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "y" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "width" DOUBLE PRECISION NOT NULL DEFAULT 150,
  "height" DOUBLE PRECISION NOT NULL DEFAULT 40,
  "required" BOOLEAN NOT NULL DEFAULT true,
  "value" TEXT,
  CONSTRAINT "esign_fields_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "esign_fields_envelope_id_idx" ON "esign_fields"("envelope_id");
ALTER TABLE "esign_fields" ADD CONSTRAINT "esign_fields_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "esign_envelopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "esign_audit_events" (
  "id" TEXT NOT NULL,
  "envelope_id" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "actor" TEXT NOT NULL DEFAULT 'system',
  "hash" TEXT NOT NULL,
  "previous_hash" TEXT,
  "body_hash" TEXT NOT NULL,
  "payload" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "esign_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "esign_audit_events_body_hash_key" UNIQUE ("body_hash")
);
CREATE INDEX "esign_audit_events_envelope_id_created_at_idx" ON "esign_audit_events"("envelope_id", "created_at");
ALTER TABLE "esign_audit_events" ADD CONSTRAINT "esign_audit_events_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "esign_envelopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
