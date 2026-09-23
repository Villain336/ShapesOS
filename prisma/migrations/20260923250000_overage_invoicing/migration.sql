-- Marketr — overage invoicing (hosted Stripe track).
-- 1. usage_events.overage_credits: factual per-charge overage marking written
--    by meter() in-transaction. Existing rows default 0 (in-cap).
-- 2. billing_workspaces: Stripe customer binding + payment-method state per
--    workspace.
-- 3. billing_overage_invoices: monthly overage invoices, replay-safe per
--    workspace per month via the idempotency key.
-- 4. billing_setup_idempotency: exactly-once guard for setup-mode Checkout
--    completions.

ALTER TABLE "usage_events" ADD COLUMN "overage_credits" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "billing_workspaces" (
  "workspace_id" TEXT PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "stripe_customer_id" TEXT,
  "has_payment_method" BOOLEAN NOT NULL DEFAULT FALSE,
  "last_overage_invoiced_through" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "billing_overage_invoices" (
  "id" TEXT PRIMARY KEY,
  "workspace_id" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "period" TEXT NOT NULL,
  "overage_credits" INTEGER NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "stripe_invoice_id" TEXT,
  "hosted_invoice_url" TEXT,
  "invoice_pdf_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'finalized',
  "idempotency_key" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "billing_overage_invoices_workspace_id_period_idx"
  ON "billing_overage_invoices"("workspace_id", "period");

CREATE TABLE IF NOT EXISTS "billing_setup_idempotency" (
  "idempotency_key" TEXT PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "stripe_session_id" TEXT NOT NULL,
  "applied_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
