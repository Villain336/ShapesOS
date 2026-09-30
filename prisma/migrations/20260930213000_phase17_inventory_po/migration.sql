-- Phase 17 slice 3: inventory + purchase orders.
--
--   * ops_products.low_stock_threshold (INTEGER NOT NULL DEFAULT 0):
--     alert when track_inventory AND stock_qty <= low_stock_threshold.
--   * ops_purchase_orders: supplier ref, line items JSON, server-computed
--     totals, lifecycle draft → sent → received / cancelled.
--     Sending is a gated money commitment (OPS_PO_SEND); receiving books
--     restock inventory txns atomically in the service layer.
--
-- Conventions (mirror the phase-17 migrations):
--   * FK workspace_id -> workspaces(id) ON DELETE CASCADE (tenant scope).
--   * ENABLE + FORCE ROW LEVEL SECURITY; tenant principal is the
--     app.workspace_id GUC. Sessions without the GUC see ZERO rows.
--
-- ERPNext is patterns-only, clean-room: original Marketr work.

CREATE TYPE "OpsPurchaseOrderStatus" AS ENUM ('draft', 'sent', 'received', 'cancelled');

ALTER TABLE "ops_products" ADD COLUMN "low_stock_threshold" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- ops_purchase_orders — supplier ref, line items, lifecycle, totals.
-- ---------------------------------------------------------------------------
CREATE TABLE "ops_purchase_orders" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "supplier_id" TEXT,
  "supplier_name" TEXT,
  "line_items" JSONB NOT NULL,
  "tax_cents" INTEGER NOT NULL DEFAULT 0,
  "subtotal_cents" INTEGER NOT NULL,
  "total_cents" INTEGER NOT NULL,
  "status" "OpsPurchaseOrderStatus" NOT NULL DEFAULT 'draft',
  "sent_at" TIMESTAMPTZ(3),
  "received_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ops_purchase_orders_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ops_purchase_orders_workspace_id_status_created_at_idx"
  ON "ops_purchase_orders"("workspace_id", "status", "created_at");
CREATE INDEX "ops_purchase_orders_workspace_id_supplier_id_idx"
  ON "ops_purchase_orders"("workspace_id", "supplier_id");
ALTER TABLE "ops_purchase_orders" ADD CONSTRAINT "ops_purchase_orders_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: tenant isolation on the new table (same pattern as slice 1).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_purchase_orders'] LOOP
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
