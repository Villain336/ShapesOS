-- Wave 2 Insurance slice 3b: bind execution + zero-custody payment handoff + lineage
-- (SPEC-INSURANCE.md §3 binding flow, §4.3–4.4).
--
-- InsurancePaymentHandoff: one record per bound policy documenting that
-- premium funds move carrier-direct through the vendor rail. Zero custody:
-- the OS never holds, floats, or routes premium funds, so this table
-- deliberately carries NO OS account fields (no account numbers, routing
-- numbers, wallet ids, or balances). custodyAssertion is always
-- "carrier_direct" (asserted in code by assertZeroCustodyHandoff).
--
-- InsuranceQuote.policyId: quote → policy lineage. A bound quote points at
-- the policy it became; binding sets it in the same transaction as the
-- policy row, so a quote can never be double-bound.

-- CreateTable
CREATE TABLE "insurance_payment_handoffs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "amount_cents" INTEGER,
    "payee_carrier" TEXT NOT NULL,
    "payee_carrier_naic" TEXT,
    "vendor_payment_ref" TEXT,
    "custody_assertion" TEXT NOT NULL DEFAULT 'carrier_direct',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_payment_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insurance_payment_handoffs_workspace_id_policy_id_idx" ON "insurance_payment_handoffs"("workspace_id", "policy_id");

-- AddForeignKey
ALTER TABLE "insurance_payment_handoffs" ADD CONSTRAINT "insurance_payment_handoffs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_payment_handoffs" ADD CONSTRAINT "insurance_payment_handoffs_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: quote → policy lineage
ALTER TABLE "insurance_quotes" ADD COLUMN "policy_id" TEXT;

-- AddForeignKey
ALTER TABLE "insurance_quotes" ADD CONSTRAINT "insurance_quotes_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
