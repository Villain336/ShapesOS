-- ShapesOS Phase 10 (finance): accounting core (chart of accounts, double-
-- entry journal, tax rates, gap-free document numbers), invoicing upgrades
-- (numbers, partial payments, credit notes, recurring schedules, tenant
-- Stripe), quotes, purchasing (vendors, RFQ stage, partial receipts, vendor
-- bills) and company expense claims. Extends the Ops layer (lib/ops/*).
--
-- Ledger law: the journal is append-only and balanced.
--   * CHECK: each line has exactly one non-negative side (debit XOR credit).
--   * Deferred constraint trigger: at COMMIT every journal entry has >= 2
--     lines and sum(debits) = sum(credits) — enforced by the database, not
--     only by lib/ops/accounting.
--   * BEFORE UPDATE/DELETE triggers reject edits; corrections are reversal
--     entries. Rows only disappear when their workspace is deleted (cascade).
-- Every new table is FORCE RLS on the app.workspace_id GUC (fail-closed).

-- CreateEnum
CREATE TYPE "OpsAccountType" AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

-- CreateEnum
CREATE TYPE "OpsInvoiceKind" AS ENUM ('invoice', 'credit_note');

-- CreateEnum
CREATE TYPE "OpsRecurrenceCadence" AS ENUM ('weekly', 'monthly', 'quarterly', 'yearly');

-- CreateEnum
CREATE TYPE "OpsQuoteStatus" AS ENUM ('draft', 'sent', 'accepted', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "OpsVendorBillStatus" AS ENUM ('draft', 'open', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "OpsExpenseClaimStatus" AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'reimbursed');

-- AlterEnum
ALTER TYPE "OpsPaymentKind" ADD VALUE 'payout';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OpsPurchaseOrderStatus" ADD VALUE 'rfq';
ALTER TYPE "OpsPurchaseOrderStatus" ADD VALUE 'rfq_sent';
ALTER TYPE "OpsPurchaseOrderStatus" ADD VALUE 'partially_received';

-- AlterTable
ALTER TABLE "ops_orders" ADD COLUMN     "quote_id" TEXT;

-- AlterTable
ALTER TABLE "ops_payments" ADD COLUMN     "bill_id" TEXT,
ADD COLUMN     "invoice_id" TEXT,
ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "ops_invoices" ADD COLUMN     "credit_note_of_id" TEXT,
ADD COLUMN     "credited_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "customer_email" TEXT,
ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "delivery_status" TEXT,
ADD COLUMN     "kind" "OpsInvoiceKind" NOT NULL DEFAULT 'invoice',
ADD COLUMN     "number" TEXT,
ADD COLUMN     "paid_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payment_link_url" TEXT,
ADD COLUMN     "quote_id" TEXT,
ADD COLUMN     "recurring_id" TEXT,
ADD COLUMN     "stripe_session_id" TEXT;

-- AlterTable
ALTER TABLE "ops_purchase_orders" ADD COLUMN     "rfq_sent_at" TIMESTAMP(3),
ADD COLUMN     "vendor_id" TEXT;

-- CreateTable
CREATE TABLE "ops_accounts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "OpsAccountType" NOT NULL,
    "parent_id" TEXT,
    "system_key" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_journal_entries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entry_date" TIMESTAMP(3) NOT NULL,
    "memo" TEXT,
    "source_type" TEXT NOT NULL DEFAULT 'manual',
    "source_id" TEXT,
    "source_key" TEXT,
    "reversal_of_id" TEXT,
    "total_cents" INTEGER NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_journal_lines" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "entry_date" TIMESTAMP(3) NOT NULL,
    "debit_cents" INTEGER NOT NULL DEFAULT 0,
    "credit_cents" INTEGER NOT NULL DEFAULT 0,
    "memo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_tax_rates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate_bps" INTEGER NOT NULL,
    "sales_account_id" TEXT,
    "purchase_account_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_number_sequences" (
    "workspace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_number_sequences_pkey" PRIMARY KEY ("workspace_id","kind")
);

-- CreateTable
CREATE TABLE "ops_finance_settings" (
    "workspace_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "invoice_from_name" TEXT,
    "invoice_footer" TEXT,
    "stripe_secret_enc" TEXT,
    "stripe_secret_hint" TEXT,
    "stripe_webhook_secret_enc" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_finance_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "ops_recurring_invoices" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "line_items" JSONB NOT NULL,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "cadence" "OpsRecurrenceCadence" NOT NULL,
    "interval_count" INTEGER NOT NULL DEFAULT 1,
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "anchor_day" INTEGER,
    "end_at" TIMESTAMP(3),
    "due_days" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "last_invoice_id" TEXT,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_recurring_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_quotes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "number" TEXT,
    "customer_id" TEXT,
    "customer_email" TEXT,
    "line_items" JSONB NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL,
    "status" "OpsQuoteStatus" NOT NULL DEFAULT 'draft',
    "valid_until" TIMESTAMP(3),
    "notes" TEXT,
    "sent_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "delivery_status" TEXT,
    "converted_order_id" TEXT,
    "converted_invoice_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_vendors" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "tax_id" TEXT,
    "address" TEXT,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "default_account_id" TEXT,
    "lead_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_purchase_receipts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "note" TEXT,
    "actor" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_purchase_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_vendor_bills" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "number" TEXT,
    "vendor_id" TEXT,
    "purchase_order_id" TEXT,
    "vendor_ref" TEXT,
    "line_items" JSONB NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "status" "OpsVendorBillStatus" NOT NULL DEFAULT 'draft',
    "bill_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMP(3),
    "posted_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_vendor_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_expense_claims" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "number" TEXT,
    "claimant_id" TEXT NOT NULL,
    "claimant_name" TEXT,
    "title" TEXT NOT NULL,
    "status" "OpsExpenseClaimStatus" NOT NULL DEFAULT 'draft',
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approval_id" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "rejected_reason" TEXT,
    "reimbursed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_expense_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_expense_lines" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "spent_at" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "account_id" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "receipt_file_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_expense_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ops_accounts_workspace_id_type_idx" ON "ops_accounts"("workspace_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ops_accounts_workspace_id_code_key" ON "ops_accounts"("workspace_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ops_accounts_workspace_id_system_key_key" ON "ops_accounts"("workspace_id", "system_key");

-- CreateIndex
CREATE UNIQUE INDEX "ops_journal_entries_reversal_of_id_key" ON "ops_journal_entries"("reversal_of_id");

-- CreateIndex
CREATE INDEX "ops_journal_entries_workspace_id_entry_date_idx" ON "ops_journal_entries"("workspace_id", "entry_date");

-- CreateIndex
CREATE INDEX "ops_journal_entries_workspace_id_source_type_source_id_idx" ON "ops_journal_entries"("workspace_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_journal_entries_workspace_id_source_key_key" ON "ops_journal_entries"("workspace_id", "source_key");

-- CreateIndex
CREATE INDEX "ops_journal_lines_workspace_id_account_id_entry_date_idx" ON "ops_journal_lines"("workspace_id", "account_id", "entry_date");

-- CreateIndex
CREATE INDEX "ops_journal_lines_entry_id_idx" ON "ops_journal_lines"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_tax_rates_workspace_id_name_key" ON "ops_tax_rates"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "ops_recurring_invoices_workspace_id_active_next_run_at_idx" ON "ops_recurring_invoices"("workspace_id", "active", "next_run_at");

-- CreateIndex
CREATE INDEX "ops_quotes_workspace_id_status_created_at_idx" ON "ops_quotes"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ops_quotes_workspace_id_customer_id_idx" ON "ops_quotes"("workspace_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_quotes_workspace_id_number_key" ON "ops_quotes"("workspace_id", "number");

-- CreateIndex
CREATE INDEX "ops_vendors_workspace_id_lead_id_idx" ON "ops_vendors"("workspace_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_vendors_workspace_id_name_key" ON "ops_vendors"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "ops_purchase_receipts_workspace_id_purchase_order_id_idx" ON "ops_purchase_receipts"("workspace_id", "purchase_order_id");

-- CreateIndex
CREATE INDEX "ops_vendor_bills_workspace_id_status_due_at_idx" ON "ops_vendor_bills"("workspace_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "ops_vendor_bills_workspace_id_vendor_id_idx" ON "ops_vendor_bills"("workspace_id", "vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_vendor_bills_workspace_id_number_key" ON "ops_vendor_bills"("workspace_id", "number");

-- CreateIndex
CREATE INDEX "ops_expense_claims_workspace_id_status_created_at_idx" ON "ops_expense_claims"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ops_expense_claims_workspace_id_claimant_id_idx" ON "ops_expense_claims"("workspace_id", "claimant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_expense_claims_workspace_id_number_key" ON "ops_expense_claims"("workspace_id", "number");

-- CreateIndex
CREATE INDEX "ops_expense_lines_workspace_id_claim_id_idx" ON "ops_expense_lines"("workspace_id", "claim_id");

-- CreateIndex
CREATE INDEX "ops_payments_workspace_id_invoice_id_idx" ON "ops_payments"("workspace_id", "invoice_id");

-- CreateIndex
CREATE INDEX "ops_payments_workspace_id_bill_id_idx" ON "ops_payments"("workspace_id", "bill_id");

-- CreateIndex
CREATE INDEX "ops_invoices_workspace_id_credit_note_of_id_idx" ON "ops_invoices"("workspace_id", "credit_note_of_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_invoices_workspace_id_number_key" ON "ops_invoices"("workspace_id", "number");

-- CreateIndex
CREATE INDEX "ops_purchase_orders_workspace_id_vendor_id_idx" ON "ops_purchase_orders"("workspace_id", "vendor_id");

-- AddForeignKey
ALTER TABLE "ops_payments" ADD CONSTRAINT "ops_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "ops_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_payments" ADD CONSTRAINT "ops_payments_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "ops_vendor_bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_invoices" ADD CONSTRAINT "ops_invoices_credit_note_of_id_fkey" FOREIGN KEY ("credit_note_of_id") REFERENCES "ops_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_purchase_orders" ADD CONSTRAINT "ops_purchase_orders_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "ops_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_accounts" ADD CONSTRAINT "ops_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_accounts" ADD CONSTRAINT "ops_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ops_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_journal_entries" ADD CONSTRAINT "ops_journal_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_journal_entries" ADD CONSTRAINT "ops_journal_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "ops_journal_entries"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_journal_lines" ADD CONSTRAINT "ops_journal_lines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_journal_lines" ADD CONSTRAINT "ops_journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "ops_journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_journal_lines" ADD CONSTRAINT "ops_journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ops_accounts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_tax_rates" ADD CONSTRAINT "ops_tax_rates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_number_sequences" ADD CONSTRAINT "ops_number_sequences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_finance_settings" ADD CONSTRAINT "ops_finance_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_recurring_invoices" ADD CONSTRAINT "ops_recurring_invoices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_quotes" ADD CONSTRAINT "ops_quotes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_vendors" ADD CONSTRAINT "ops_vendors_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_purchase_receipts" ADD CONSTRAINT "ops_purchase_receipts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_purchase_receipts" ADD CONSTRAINT "ops_purchase_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "ops_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_vendor_bills" ADD CONSTRAINT "ops_vendor_bills_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_vendor_bills" ADD CONSTRAINT "ops_vendor_bills_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "ops_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_vendor_bills" ADD CONSTRAINT "ops_vendor_bills_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "ops_purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_expense_claims" ADD CONSTRAINT "ops_expense_claims_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_expense_lines" ADD CONSTRAINT "ops_expense_lines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_expense_lines" ADD CONSTRAINT "ops_expense_lines_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "ops_expense_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- Ledger integrity (Phase 10 finance).
-- ============================================================
ALTER TABLE "ops_journal_lines" ADD CONSTRAINT "ops_journal_lines_one_side_chk"
  CHECK ("debit_cents" >= 0 AND "credit_cents" >= 0 AND (("debit_cents" > 0) <> ("credit_cents" > 0)));
ALTER TABLE "ops_journal_entries" ADD CONSTRAINT "ops_journal_entries_total_chk" CHECK ("total_cents" > 0);
ALTER TABLE "ops_tax_rates" ADD CONSTRAINT "ops_tax_rates_rate_chk" CHECK ("rate_bps" >= 0 AND "rate_bps" <= 10000);
ALTER TABLE "ops_invoices" ADD CONSTRAINT "ops_invoices_settled_chk"
  CHECK ("paid_cents" >= 0 AND "credited_cents" >= 0 AND "paid_cents" + "credited_cents" <= "total_cents");
ALTER TABLE "ops_vendor_bills" ADD CONSTRAINT "ops_vendor_bills_paid_chk"
  CHECK ("paid_cents" >= 0 AND "paid_cents" <= "total_cents");

-- Balanced at commit: runs once per inserted line / entry, after all the
-- transaction's statements, so an entry and its lines can be inserted in any
-- order inside one transaction.
CREATE OR REPLACE FUNCTION ops_journal_assert_balanced() RETURNS trigger AS $$
DECLARE
  eid TEXT;
  d BIGINT;
  c BIGINT;
  n INT;
BEGIN
  IF TG_TABLE_NAME = 'ops_journal_entries' THEN
    eid := NEW.id;
  ELSE
    eid := NEW.entry_id;
  END IF;
  SELECT COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0), COUNT(*)
    INTO d, c, n FROM ops_journal_lines WHERE entry_id = eid;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'ops journal entry % is not balanced: debits % <> credits % (% lines)', eid, d, c, n
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'ops_journal_entries' THEN
    IF NEW.total_cents <> d THEN
      RAISE EXCEPTION 'ops journal entry % total % does not match its debits %', eid, NEW.total_cents, d
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ops_journal_lines_balanced
  AFTER INSERT ON "ops_journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ops_journal_assert_balanced();
CREATE CONSTRAINT TRIGGER ops_journal_entries_balanced
  AFTER INSERT ON "ops_journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ops_journal_assert_balanced();

-- Append-only: no UPDATE ever; DELETE only as part of deleting the whole
-- workspace (the FK cascade runs after the workspace row is gone).
CREATE OR REPLACE FUNCTION ops_journal_prevent_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % not allowed (post a reversal entry instead)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ops_journal_entries_no_mutation
  BEFORE UPDATE OR DELETE ON "ops_journal_entries"
  FOR EACH ROW EXECUTE FUNCTION ops_journal_prevent_mutation();
CREATE TRIGGER ops_journal_lines_no_mutation
  BEFORE UPDATE OR DELETE ON "ops_journal_lines"
  FOR EACH ROW EXECUTE FUNCTION ops_journal_prevent_mutation();
CREATE TRIGGER ops_purchase_receipts_no_mutation
  BEFORE UPDATE OR DELETE ON "ops_purchase_receipts"
  FOR EACH ROW EXECUTE FUNCTION ops_journal_prevent_mutation();

-- ============================================================
-- Vendors: link existing purchase orders (supplier lead / free-text name)
-- to vendor rows. supplier_id / supplier_name stay readable on the PO.
-- ============================================================
INSERT INTO "ops_vendors" ("id", "workspace_id", "name", "lead_id", "updated_at")
SELECT 'ven_' || md5(src.workspace_id || ':' || src.name), src.workspace_id, src.name, MIN(src.lead_id), now()
FROM (
  SELECT po.workspace_id,
         COALESCE(NULLIF(btrim(l.name), ''), NULLIF(btrim(po.supplier_name), '')) AS name,
         l.id AS lead_id
  FROM "ops_purchase_orders" po
  LEFT JOIN "crm_leads" l ON l.id = po.supplier_id AND l.workspace_id = po.workspace_id
) src
WHERE src.name IS NOT NULL
GROUP BY src.workspace_id, src.name
ON CONFLICT ("workspace_id", "name") DO NOTHING;

UPDATE "ops_purchase_orders" po
SET "vendor_id" = v.id
FROM "ops_vendors" v
WHERE v.workspace_id = po.workspace_id
  AND po.vendor_id IS NULL
  AND v.name = COALESCE(
    (SELECT NULLIF(btrim(l2.name), '') FROM "crm_leads" l2 WHERE l2.id = po.supplier_id AND l2.workspace_id = po.workspace_id),
    NULLIF(btrim(po.supplier_name), '')
  );

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17 migrations.
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ops_accounts', 'ops_journal_entries', 'ops_journal_lines', 'ops_tax_rates',
    'ops_number_sequences', 'ops_finance_settings', 'ops_recurring_invoices',
    'ops_quotes', 'ops_vendors', 'ops_purchase_receipts', 'ops_vendor_bills',
    'ops_expense_claims', 'ops_expense_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
