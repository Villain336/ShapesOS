-- Phase 17 slice 1: Business Operations — DocType-style entity convention.
-- The framework every Operations entity plugs into (spec build-order step 1).
--
-- Eight tenant-scoped entities + the audit-by-construction table:
--   ops_products, ops_orders, ops_payments, ops_invoices, ops_promotions,
--   ops_inventory_txns, ops_projects, ops_workflow_runs, ops_audit_events.
--
-- Money law (locked): ops_payments rows are RECORDS ONLY — Marketr never
-- holds funds. Amounts are integer minor units (cents).
--
-- Conventions (mirror the phase-16 migrations):
--   * FK workspace_id -> workspaces(id) ON DELETE CASCADE (tenant scope).
--   * (workspace_id, ...) indexes for the tenant's hot queries.
--   * ENABLE + FORCE ROW LEVEL SECURITY on every table; the tenant principal
--     is the app.workspace_id GUC. Sessions without the GUC see ZERO rows
--     (fail-closed) — all reads/writes go through withWorkspaceScope().
--
-- ERPNext is patterns-only, clean-room: this schema is original Marketr
-- work. No ERPNext code, schema, or UI text exists in this repo.
--
-- `prisma migrate deploy` against the durable PG (:5433) is deferred to
-- phase verification; this SQL is validated on a scratch DB in the slice.

CREATE TYPE "OpsOrderStatus" AS ENUM ('draft', 'confirmed', 'fulfilled', 'cancelled');
CREATE TYPE "OpsPaymentKind" AS ENUM ('charge', 'refund');
CREATE TYPE "OpsPaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'refunded');
CREATE TYPE "OpsInvoiceStatus" AS ENUM ('draft', 'sent', 'paid', 'overdue', 'cancelled');
CREATE TYPE "OpsInventoryReason" AS ENUM ('sale', 'restock', 'adjustment');
CREATE TYPE "OpsProjectStatus" AS ENUM ('planning', 'active', 'on_hold', 'completed', 'cancelled');
CREATE TYPE "OpsWorkflowRunStatus" AS ENUM ('running', 'succeeded', 'failed', 'compensated');

-- ---------------------------------------------------------------------------
-- ops_products — catalog: name, sku, price, stock, track-inventory flag.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_products" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "price_cents" INTEGER NOT NULL,
  "stock_qty" INTEGER NOT NULL DEFAULT 0,
  "track_inventory" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ops_products_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ops_products_workspace_id_sku_key" ON "ops_products"("workspace_id", "sku");
CREATE INDEX "ops_products_workspace_id_name_idx" ON "ops_products"("workspace_id", "name");
ALTER TABLE "ops_products" ADD CONSTRAINT "ops_products_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ops_orders — customer ref, line items JSON, lifecycle, server-computed totals.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_orders" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "customer_id" TEXT,
  "line_items" JSONB NOT NULL,
  "status" "OpsOrderStatus" NOT NULL DEFAULT 'draft',
  "subtotal_cents" INTEGER NOT NULL,
  "tax_cents" INTEGER NOT NULL DEFAULT 0,
  "total_cents" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ops_orders_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_orders_workspace_id_status_created_at_idx"
  ON "ops_orders"("workspace_id", "status", "created_at");
CREATE INDEX "ops_orders_workspace_id_customer_id_idx"
  ON "ops_orders"("workspace_id", "customer_id");
ALTER TABLE "ops_orders" ADD CONSTRAINT "ops_orders_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ops_payments — RECORDS ONLY. Funds never touch Marketr.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_payments" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "order_id" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'stripe',
  "kind" "OpsPaymentKind" NOT NULL DEFAULT 'charge',
  "amount_cents" INTEGER NOT NULL,
  "status" "OpsPaymentStatus" NOT NULL DEFAULT 'pending',
  "provider_ref" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_payments_workspace_id_order_id_created_at_idx"
  ON "ops_payments"("workspace_id", "order_id", "created_at");
CREATE INDEX "ops_payments_workspace_id_kind_status_idx"
  ON "ops_payments"("workspace_id", "kind", "status");
ALTER TABLE "ops_payments" ADD CONSTRAINT "ops_payments_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ops_payments" ADD CONSTRAINT "ops_payments_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "ops_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ops_promotions — discount codes + rules JSON + usage limits.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_promotions" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "rules" JSONB NOT NULL DEFAULT '{}',
  "usage_limit" INTEGER,
  "used_count" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ops_promotions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ops_promotions_workspace_id_code_key" ON "ops_promotions"("workspace_id", "code");
CREATE INDEX "ops_promotions_workspace_id_active_idx" ON "ops_promotions"("workspace_id", "active");
ALTER TABLE "ops_promotions" ADD CONSTRAINT "ops_promotions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ops_invoices — customer ref, line items, tax; draft → sent → paid.
-- Sending is a gated write (medium, approval required — money red lane).
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_invoices" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "customer_id" TEXT,
  "line_items" JSONB NOT NULL,
  "tax_cents" INTEGER NOT NULL DEFAULT 0,
  "total_cents" INTEGER NOT NULL,
  "status" "OpsInvoiceStatus" NOT NULL DEFAULT 'draft',
  "sent_at" TIMESTAMPTZ(3),
  "idempotency_key" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ops_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ops_invoices_workspace_id_idempotency_key_key"
  ON "ops_invoices"("workspace_id", "idempotency_key");
CREATE INDEX "ops_invoices_workspace_id_status_created_at_idx"
  ON "ops_invoices"("workspace_id", "status", "created_at");
CREATE INDEX "ops_invoices_workspace_id_customer_id_idx"
  ON "ops_invoices"("workspace_id", "customer_id");
ALTER TABLE "ops_invoices" ADD CONSTRAINT "ops_invoices_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ops_inventory_txns — immutable stock ledger (no updated_at by design).
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_inventory_txns" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "delta" INTEGER NOT NULL,
  "reason" "OpsInventoryReason" NOT NULL,
  "actor" TEXT,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_inventory_txns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_inventory_txns_workspace_id_product_id_created_at_idx"
  ON "ops_inventory_txns"("workspace_id", "product_id", "created_at");
CREATE INDEX "ops_inventory_txns_workspace_id_reason_created_at_idx"
  ON "ops_inventory_txns"("workspace_id", "reason", "created_at");
ALTER TABLE "ops_inventory_txns" ADD CONSTRAINT "ops_inventory_txns_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ops_inventory_txns" ADD CONSTRAINT "ops_inventory_txns_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "ops_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ops_projects — client delivery work, milestones JSON, CRM lead/deal links.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_projects" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "customer_id" TEXT,
  "name" TEXT NOT NULL,
  "milestones" JSONB NOT NULL DEFAULT '[]',
  "status" "OpsProjectStatus" NOT NULL DEFAULT 'planning',
  "lead_id" TEXT,
  "deal_id" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ops_projects_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_projects_workspace_id_status_created_at_idx"
  ON "ops_projects"("workspace_id", "status", "created_at");
CREATE INDEX "ops_projects_workspace_id_lead_id_idx"
  ON "ops_projects"("workspace_id", "lead_id");
ALTER TABLE "ops_projects" ADD CONSTRAINT "ops_projects_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ops_workflow_runs — Medusa-Workflows-inspired transactional record
-- (clean-room): named multi-step operation + append-only compensation log.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_workflow_runs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "workflow_name" TEXT NOT NULL,
  "steps" JSONB NOT NULL DEFAULT '[]',
  "compensation_log" JSONB NOT NULL DEFAULT '[]',
  "status" "OpsWorkflowRunStatus" NOT NULL DEFAULT 'running',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ops_workflow_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_workflow_runs_workspace_id_workflow_name_created_at_idx"
  ON "ops_workflow_runs"("workspace_id", "workflow_name", "created_at");
CREATE INDEX "ops_workflow_runs_workspace_id_status_idx"
  ON "ops_workflow_runs"("workspace_id", "status");
ALTER TABLE "ops_workflow_runs" ADD CONSTRAINT "ops_workflow_runs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ops_audit_events — audit by construction: one row per DocType API request
-- (reads and draft-creators included). Append-only; the API never updates
-- or deletes these rows.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_audit_events" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entity_id" TEXT,
  "action" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_audit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_audit_events_workspace_id_entity_created_at_idx"
  ON "ops_audit_events"("workspace_id", "entity", "created_at");
CREATE INDEX "ops_audit_events_workspace_id_entity_id_idx"
  ON "ops_audit_events"("workspace_id", "entity_id");
ALTER TABLE "ops_audit_events" ADD CONSTRAINT "ops_audit_events_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant-isolation pattern as the phase-16 migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ops_products', 'ops_orders', 'ops_payments', 'ops_promotions',
    'ops_invoices', 'ops_inventory_txns', 'ops_projects',
    'ops_workflow_runs', 'ops_audit_events'
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
