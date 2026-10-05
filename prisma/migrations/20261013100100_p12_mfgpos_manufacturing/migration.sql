-- ShapesOS Phase 12 (mfgpos): MANUFACTURING on the Ops layer.
--
--   ops_work_centers          machines / benches: capacity, hourly cost,
--                             optional location (digital-twin binding)
--   ops_routings              how a product is made: its CAD BOM revision
--                             (the product-level BOM is DERIVED from it — no
--                             second BOM model) + ordered operations JSON
--   ops_manufacturing_orders  draft → confirmed → in_progress → done
--                             (cancelled): component snapshot, locations,
--                             produced/scrapped quantities, costing
--   ops_work_orders           one per routing step, timer state
--   ops_work_time_logs        append-only time segments / manual entries
--   ops_scraps                stock written off to the virtual scrap location
--   cad_parts.ops_product_id  the CAD part ↔ Ops product link a BOM line is
--                             consumed through
--
-- Stock never moves here: completion books consumption/production rows
-- through the Phase 10 ledger, costing posts through the append-only,
-- DB-balanced journal. Every new table is FORCE RLS on app.workspace_id and
-- cascades from workspaces.

-- CreateEnum
CREATE TYPE "OpsMoStatus" AS ENUM ('draft', 'confirmed', 'in_progress', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "OpsWorkOrderStatus" AS ENUM ('pending', 'in_progress', 'paused', 'done', 'cancelled');

-- AlterTable
ALTER TABLE "cad_parts" ADD COLUMN     "ops_product_id" TEXT;

-- CreateTable
CREATE TABLE "ops_work_centers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "hourly_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "location_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_work_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_routings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "bom_version_id" TEXT,
    "name" TEXT NOT NULL,
    "operations" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_routings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_manufacturing_orders" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "number" TEXT,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "qty" INTEGER NOT NULL,
    "status" "OpsMoStatus" NOT NULL DEFAULT 'draft',
    "routing_id" TEXT,
    "bom_version_id" TEXT,
    "component_location_id" TEXT,
    "finished_location_id" TEXT,
    "components" JSONB NOT NULL DEFAULT '[]',
    "planned_start" TIMESTAMP(3),
    "planned_cost_cents" INTEGER,
    "cost_estimate_id" TEXT,
    "produced_qty" INTEGER NOT NULL DEFAULT 0,
    "scrapped_qty" INTEGER NOT NULL DEFAULT 0,
    "component_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "labour_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "scrap_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "finished_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_manufacturing_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_work_orders" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "mo_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "work_center_id" TEXT NOT NULL,
    "planned_minutes" INTEGER NOT NULL DEFAULT 0,
    "status" "OpsWorkOrderStatus" NOT NULL DEFAULT 'pending',
    "actual_seconds" INTEGER NOT NULL DEFAULT 0,
    "running_since" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_work_time_logs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "seconds" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_work_time_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_scraps" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "qty" INTEGER NOT NULL,
    "location_id" TEXT,
    "mo_id" TEXT,
    "reason" TEXT NOT NULL,
    "unit_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "inventory_txn_id" TEXT,
    "journal_entry_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_scraps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_work_centers_workspace_id_code_key" ON "ops_work_centers"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "ops_routings_workspace_id_product_id_active_idx" ON "ops_routings"("workspace_id", "product_id", "active");

-- CreateIndex
CREATE INDEX "ops_manufacturing_orders_workspace_id_status_created_at_idx" ON "ops_manufacturing_orders"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ops_manufacturing_orders_workspace_id_product_id_idx" ON "ops_manufacturing_orders"("workspace_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_manufacturing_orders_workspace_id_number_key" ON "ops_manufacturing_orders"("workspace_id", "number");

-- CreateIndex
CREATE INDEX "ops_work_orders_workspace_id_work_center_id_status_idx" ON "ops_work_orders"("workspace_id", "work_center_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ops_work_orders_mo_id_sequence_key" ON "ops_work_orders"("mo_id", "sequence");

-- CreateIndex
CREATE INDEX "ops_work_time_logs_workspace_id_work_order_id_idx" ON "ops_work_time_logs"("workspace_id", "work_order_id");

-- CreateIndex
CREATE INDEX "ops_scraps_workspace_id_created_at_idx" ON "ops_scraps"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "ops_scraps_workspace_id_mo_id_idx" ON "ops_scraps"("workspace_id", "mo_id");

-- CreateIndex
CREATE INDEX "cad_parts_workspace_id_ops_product_id_idx" ON "cad_parts"("workspace_id", "ops_product_id");

-- AddForeignKey
ALTER TABLE "cad_parts" ADD CONSTRAINT "cad_parts_ops_product_id_fkey" FOREIGN KEY ("ops_product_id") REFERENCES "ops_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_work_centers" ADD CONSTRAINT "ops_work_centers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_work_centers" ADD CONSTRAINT "ops_work_centers_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "ops_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_routings" ADD CONSTRAINT "ops_routings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_routings" ADD CONSTRAINT "ops_routings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "ops_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_routings" ADD CONSTRAINT "ops_routings_bom_version_id_fkey" FOREIGN KEY ("bom_version_id") REFERENCES "cad_bom_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_manufacturing_orders" ADD CONSTRAINT "ops_manufacturing_orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_manufacturing_orders" ADD CONSTRAINT "ops_manufacturing_orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "ops_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_manufacturing_orders" ADD CONSTRAINT "ops_manufacturing_orders_routing_id_fkey" FOREIGN KEY ("routing_id") REFERENCES "ops_routings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_manufacturing_orders" ADD CONSTRAINT "ops_manufacturing_orders_bom_version_id_fkey" FOREIGN KEY ("bom_version_id") REFERENCES "cad_bom_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_manufacturing_orders" ADD CONSTRAINT "ops_manufacturing_orders_component_location_id_fkey" FOREIGN KEY ("component_location_id") REFERENCES "ops_locations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_manufacturing_orders" ADD CONSTRAINT "ops_manufacturing_orders_finished_location_id_fkey" FOREIGN KEY ("finished_location_id") REFERENCES "ops_locations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_work_orders" ADD CONSTRAINT "ops_work_orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_work_orders" ADD CONSTRAINT "ops_work_orders_mo_id_fkey" FOREIGN KEY ("mo_id") REFERENCES "ops_manufacturing_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_work_orders" ADD CONSTRAINT "ops_work_orders_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "ops_work_centers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_work_time_logs" ADD CONSTRAINT "ops_work_time_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_work_time_logs" ADD CONSTRAINT "ops_work_time_logs_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "ops_work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_scraps" ADD CONSTRAINT "ops_scraps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_scraps" ADD CONSTRAINT "ops_scraps_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "ops_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_scraps" ADD CONSTRAINT "ops_scraps_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "ops_locations"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_scraps" ADD CONSTRAINT "ops_scraps_mo_id_fkey" FOREIGN KEY ("mo_id") REFERENCES "ops_manufacturing_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Guards the service computes and the database holds.
ALTER TABLE "ops_work_centers" ADD CONSTRAINT "ops_work_centers_money_chk"
  CHECK ("capacity" >= 1 AND "hourly_cost_cents" >= 0);
ALTER TABLE "ops_manufacturing_orders" ADD CONSTRAINT "ops_manufacturing_orders_qty_chk"
  CHECK ("qty" >= 1 AND "produced_qty" >= 0 AND "scrapped_qty" >= 0
         AND "component_cost_cents" >= 0 AND "labour_cost_cents" >= 0
         AND "scrap_cost_cents" >= 0 AND "finished_cost_cents" >= 0);
ALTER TABLE "ops_work_orders" ADD CONSTRAINT "ops_work_orders_time_chk"
  CHECK ("actual_seconds" >= 0 AND "planned_minutes" >= 0 AND "sequence" >= 0);
ALTER TABLE "ops_work_time_logs" ADD CONSTRAINT "ops_work_time_logs_seconds_chk"
  CHECK ("seconds" >= 0 AND "ended_at" >= "started_at");
ALTER TABLE "ops_scraps" ADD CONSTRAINT "ops_scraps_qty_chk"
  CHECK ("qty" >= 1 AND "unit_cost_cents" >= 0 AND "total_cost_cents" >= 0);

-- Time logs are append-only (corrections are new manual entries).
CREATE OR REPLACE FUNCTION ops_work_time_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ops_work_time_logs is append-only';
END $$;
CREATE TRIGGER ops_work_time_logs_no_update
  BEFORE UPDATE ON "ops_work_time_logs"
  FOR EACH ROW EXECUTE FUNCTION ops_work_time_logs_append_only();

-- Row-level security: fail-closed tenant isolation.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_work_centers', 'ops_routings', 'ops_manufacturing_orders', 'ops_work_orders', 'ops_work_time_logs', 'ops_scraps'] LOOP
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
