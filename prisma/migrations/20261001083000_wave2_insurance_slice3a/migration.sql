-- Wave 2 Insurance slice 3a: governed-action approval + audit framework (SPEC-INSURANCE.md §4.3–4.4).
-- InsuranceAuditEvent: one record per human decision on a governed action
-- (approved or denied) — who approved, what (payload snapshot), timestamp,
-- vendor transaction ref once the licensed rail executes.
-- InsuranceQuoteRule: per-line-of-business standing pre-approval for
-- request_quote only. bind_policy NEVER gets a standing rule (no auto-bind).

-- CreateTable
CREATE TABLE "insurance_audit_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "vendor_transaction_ref" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insurance_audit_events_workspace_id_action_created_at_idx" ON "insurance_audit_events"("workspace_id", "action", "created_at");

-- CreateTable
CREATE TABLE "insurance_quote_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "line_of_business" TEXT NOT NULL,
    "approved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_quote_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "insurance_quote_rules_workspace_id_line_of_business_key" ON "insurance_quote_rules"("workspace_id", "line_of_business");

-- AddForeignKey
ALTER TABLE "insurance_audit_events" ADD CONSTRAINT "insurance_audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_quote_rules" ADD CONSTRAINT "insurance_quote_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
