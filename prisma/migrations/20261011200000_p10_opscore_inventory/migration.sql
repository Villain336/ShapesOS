-- ShapesOS Phase 10 (ops-core): inventory — warehouses, hierarchical
-- locations (warehouse → zone → aisle → rack → shelf → bin; docks), product
-- variants, location/variant-aware stock ledger, transfers, reorder rules.
-- Per-location stock is derived from ops_inventory_txns (never stored).
-- Every new table is FORCE RLS on the app.workspace_id GUC (fail-closed) and
-- cascades from workspaces.

-- CreateEnum
CREATE TYPE "OpsLocationKind" AS ENUM ('zone', 'aisle', 'rack', 'shelf', 'bin', 'dock');

-- CreateEnum
CREATE TYPE "OpsTransferStatus" AS ENUM ('draft', 'done', 'cancelled');

-- AlterEnum
ALTER TYPE "OpsInventoryReason" ADD VALUE 'transfer';

-- AlterTable
ALTER TABLE "ops_inventory_txns" ADD COLUMN     "location_id" TEXT,
ADD COLUMN     "transfer_id" TEXT,
ADD COLUMN     "variant_id" TEXT;

-- CreateTable
CREATE TABLE "ops_warehouses" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_locations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "kind" "OpsLocationKind" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "path" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_product_variants" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "price_cents" INTEGER,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_transfers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "from_location_id" TEXT NOT NULL,
    "to_location_id" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "status" "OpsTransferStatus" NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "created_by" TEXT,
    "done_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_reorder_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "warehouse_id" TEXT NOT NULL,
    "receive_location_id" TEXT,
    "min_qty" INTEGER NOT NULL,
    "max_qty" INTEGER NOT NULL,
    "supplier_name" TEXT,
    "unit_cost_cents" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "open_purchase_order_id" TEXT,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_reorder_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_warehouses_workspace_id_code_key" ON "ops_warehouses"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "ops_locations_workspace_id_warehouse_id_parent_id_idx" ON "ops_locations"("workspace_id", "warehouse_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_locations_warehouse_id_code_key" ON "ops_locations"("warehouse_id", "code");

-- CreateIndex
CREATE INDEX "ops_product_variants_workspace_id_product_id_idx" ON "ops_product_variants"("workspace_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_product_variants_workspace_id_sku_key" ON "ops_product_variants"("workspace_id", "sku");

-- CreateIndex
CREATE INDEX "ops_transfers_workspace_id_status_created_at_idx" ON "ops_transfers"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ops_reorder_rules_workspace_id_active_idx" ON "ops_reorder_rules"("workspace_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ops_reorder_rules_workspace_id_product_id_warehouse_id_vari_key" ON "ops_reorder_rules"("workspace_id", "product_id", "warehouse_id", "variant_id");

-- CreateIndex
CREATE INDEX "ops_inventory_txns_workspace_id_location_id_product_id_idx" ON "ops_inventory_txns"("workspace_id", "location_id", "product_id");

-- AddForeignKey
ALTER TABLE "ops_warehouses" ADD CONSTRAINT "ops_warehouses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_locations" ADD CONSTRAINT "ops_locations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_locations" ADD CONSTRAINT "ops_locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "ops_warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_locations" ADD CONSTRAINT "ops_locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ops_locations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_product_variants" ADD CONSTRAINT "ops_product_variants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_product_variants" ADD CONSTRAINT "ops_product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "ops_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_transfers" ADD CONSTRAINT "ops_transfers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_transfers" ADD CONSTRAINT "ops_transfers_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "ops_locations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_transfers" ADD CONSTRAINT "ops_transfers_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "ops_locations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_reorder_rules" ADD CONSTRAINT "ops_reorder_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_reorder_rules" ADD CONSTRAINT "ops_reorder_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "ops_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_reorder_rules" ADD CONSTRAINT "ops_reorder_rules_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "ops_product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_reorder_rules" ADD CONSTRAINT "ops_reorder_rules_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "ops_warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_reorder_rules" ADD CONSTRAINT "ops_reorder_rules_receive_location_id_fkey" FOREIGN KEY ("receive_location_id") REFERENCES "ops_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_inventory_txns" ADD CONSTRAINT "ops_inventory_txns_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "ops_product_variants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_inventory_txns" ADD CONSTRAINT "ops_inventory_txns_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "ops_locations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_inventory_txns" ADD CONSTRAINT "ops_inventory_txns_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "ops_transfers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ============================================================
-- Backfill: every existing product becomes single-variant. The default
-- variant id is deterministic ('pvd_' || product id) so the app's lazy
-- ensureDefaultVariant (lib/ops/stock.ts) is idempotent with it. Existing
-- ledger rows point at that variant; their location stays NULL
-- (unlocated history). stockQty is untouched — it stays the product total.
-- ============================================================
INSERT INTO "ops_product_variants" ("id", "workspace_id", "product_id", "sku", "name", "attributes", "is_default", "active", "created_at", "updated_at")
SELECT 'pvd_' || p."id", p."workspace_id", p."id", p."sku", p."name", '{}'::jsonb, true, true, now(), now()
  FROM "ops_products" p
ON CONFLICT DO NOTHING;

UPDATE "ops_inventory_txns" t
   SET "variant_id" = 'pvd_' || t."product_id"
 WHERE t."variant_id" IS NULL;

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17 migrations.
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_warehouses', 'ops_locations', 'ops_product_variants', 'ops_transfers', 'ops_reorder_rules'] LOOP
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
