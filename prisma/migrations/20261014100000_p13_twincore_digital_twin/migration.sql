-- ShapesOS Phase 13 (twincore): the DIGITAL TWIN layout layer + dock bookings.
--
--   ops_sites          one isometric site (warehouse | factory | store) laid
--                      over an existing ops_warehouses row (one per
--                      warehouse); draft → published is a gated step
--   ops_site_objects   laid-out objects on the site grid, each optionally
--                      BOUND to a record (location / work centre / register /
--                      product). Live state is derived from the bound record
--                      at read time and never stored here — the equipment_*
--                      / task_* / home_* columns (equipment only) are the one
--                      exception, because nothing else records forklifts
--   ops_dock_bookings  a truck booked at a dock (an ops_locations row of kind
--                      dock) serving at most one purchase order / order /
--                      stock move; booked → arrived → loading|unloading →
--                      done (any active → cancelled)
--
-- A dock never holds two overlapping ACTIVE bookings: the service checks it
-- and the exclusion constraint below enforces it on [eta, eta + duration).
-- All three tables are FORCE RLS on app.workspace_id and cascade from
-- workspaces.

-- btree_gist (a trusted contrib extension) lets the exclusion constraint
-- compare the dock id with "=" next to the time-range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "OpsSiteKind" AS ENUM ('warehouse', 'factory', 'store');

-- CreateEnum
CREATE TYPE "OpsSiteStatus" AS ENUM ('draft', 'published');

-- CreateEnum
CREATE TYPE "OpsSiteObjectKind" AS ENUM ('building', 'dock_door', 'rack', 'bin_zone', 'yard_slot', 'work_center', 'register', 'shelf', 'path', 'equipment');

-- CreateEnum
CREATE TYPE "OpsSiteBindingType" AS ENUM ('location', 'work_center', 'register', 'product');

-- CreateEnum
CREATE TYPE "OpsEquipmentStatus" AS ENUM ('available', 'busy', 'charging');

-- CreateEnum
CREATE TYPE "OpsDockDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "OpsDockBookingStatus" AS ENUM ('booked', 'arrived', 'loading', 'unloading', 'done', 'cancelled');

-- CreateTable
CREATE TABLE "ops_sites" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" "OpsSiteKind" NOT NULL,
    "status" "OpsSiteStatus" NOT NULL DEFAULT 'draft',
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "grid_w" INTEGER NOT NULL,
    "grid_d" INTEGER NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "notes" TEXT,
    "created_by" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_site_objects" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "kind" "OpsSiteObjectKind" NOT NULL,
    "label" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "z" INTEGER NOT NULL,
    "w" INTEGER NOT NULL DEFAULT 1,
    "d" INTEGER NOT NULL DEFAULT 1,
    "h" INTEGER NOT NULL DEFAULT 1,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "binding_type" "OpsSiteBindingType",
    "binding_id" TEXT,
    "equipment_status" "OpsEquipmentStatus",
    "task_location_id" TEXT,
    "task_note" TEXT,
    "task_assigned_at" TIMESTAMP(3),
    "home_x" INTEGER,
    "home_z" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_site_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_dock_bookings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "dock_location_id" TEXT NOT NULL,
    "direction" "OpsDockDirection" NOT NULL,
    "carrier" TEXT,
    "truck_ref" TEXT,
    "purchase_order_id" TEXT,
    "order_id" TEXT,
    "transfer_id" TEXT,
    "eta" TIMESTAMP(3) NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 60,
    "status" "OpsDockBookingStatus" NOT NULL DEFAULT 'booked',
    "arrived_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_dock_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_sites_warehouse_id_key" ON "ops_sites"("warehouse_id");

-- CreateIndex
CREATE INDEX "ops_sites_workspace_id_status_idx" ON "ops_sites"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ops_sites_workspace_id_code_key" ON "ops_sites"("workspace_id", "code");

-- CreateIndex
CREATE INDEX "ops_site_objects_workspace_id_site_id_idx" ON "ops_site_objects"("workspace_id", "site_id");

-- CreateIndex
CREATE INDEX "ops_site_objects_workspace_id_binding_type_binding_id_idx" ON "ops_site_objects"("workspace_id", "binding_type", "binding_id");

-- CreateIndex
CREATE INDEX "ops_dock_bookings_workspace_id_site_id_status_idx" ON "ops_dock_bookings"("workspace_id", "site_id", "status");

-- CreateIndex
CREATE INDEX "ops_dock_bookings_workspace_id_dock_location_id_eta_idx" ON "ops_dock_bookings"("workspace_id", "dock_location_id", "eta");

-- AddForeignKey
ALTER TABLE "ops_sites" ADD CONSTRAINT "ops_sites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_sites" ADD CONSTRAINT "ops_sites_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "ops_warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_site_objects" ADD CONSTRAINT "ops_site_objects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_site_objects" ADD CONSTRAINT "ops_site_objects_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "ops_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_site_objects" ADD CONSTRAINT "ops_site_objects_task_location_id_fkey" FOREIGN KEY ("task_location_id") REFERENCES "ops_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_dock_bookings" ADD CONSTRAINT "ops_dock_bookings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_dock_bookings" ADD CONSTRAINT "ops_dock_bookings_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "ops_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_dock_bookings" ADD CONSTRAINT "ops_dock_bookings_dock_location_id_fkey" FOREIGN KEY ("dock_location_id") REFERENCES "ops_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_dock_bookings" ADD CONSTRAINT "ops_dock_bookings_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "ops_purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_dock_bookings" ADD CONSTRAINT "ops_dock_bookings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "ops_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_dock_bookings" ADD CONSTRAINT "ops_dock_bookings_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "ops_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Layout sanity (the service validates the same rules with friendly errors).
ALTER TABLE "ops_sites" ADD CONSTRAINT "ops_sites_grid_chk"
  CHECK ("grid_w" BETWEEN 4 AND 400 AND "grid_d" BETWEEN 4 AND 400);
ALTER TABLE "ops_site_objects" ADD CONSTRAINT "ops_site_objects_footprint_chk"
  CHECK ("x" >= 0 AND "z" >= 0 AND "w" BETWEEN 1 AND 400 AND "d" BETWEEN 1 AND 400 AND "h" BETWEEN 1 AND 50
         AND "rotation" IN (0, 90, 180, 270));
ALTER TABLE "ops_site_objects" ADD CONSTRAINT "ops_site_objects_binding_chk"
  CHECK (("binding_type" IS NULL) = ("binding_id" IS NULL));
-- Stored state is for equipment only: every other object derives its state.
ALTER TABLE "ops_site_objects" ADD CONSTRAINT "ops_site_objects_equipment_only_chk"
  CHECK ("kind" = 'equipment' OR ("equipment_status" IS NULL AND "task_location_id" IS NULL AND "task_note" IS NULL
         AND "task_assigned_at" IS NULL AND "home_x" IS NULL AND "home_z" IS NULL));
ALTER TABLE "ops_dock_bookings" ADD CONSTRAINT "ops_dock_bookings_serves_one_chk"
  CHECK (num_nonnulls("purchase_order_id", "order_id", "transfer_id") <= 1);
ALTER TABLE "ops_dock_bookings" ADD CONSTRAINT "ops_dock_bookings_duration_chk"
  CHECK ("duration_minutes" BETWEEN 5 AND 1440);

-- The DB guard: no two active bookings of one dock overlap in time.
ALTER TABLE "ops_dock_bookings" ADD CONSTRAINT "ops_dock_bookings_no_overlap"
  EXCLUDE USING gist (
    "dock_location_id" WITH =,
    tsrange("eta", "eta" + "duration_minutes" * interval '1 minute') WITH &&
  ) WHERE ("status" IN ('booked', 'arrived', 'loading', 'unloading'));

-- Row-level security: fail-closed tenant isolation.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_sites', 'ops_site_objects', 'ops_dock_bookings'] LOOP
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
