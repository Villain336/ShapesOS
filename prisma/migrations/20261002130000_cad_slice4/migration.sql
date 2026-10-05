-- CAD + Hardware slice 4: hardware project management — parts inventory,
-- auditable stock events, suppliers with quoted-cost sourcing, revision-
-- linked tasks/issues, and the CadBomLine.inventoryPartId link.
--
-- Hand-authored (migrate dev is broken on this box: the pgserver-bundled PG
-- lacks pgcrypto contrib files for the shadow DB — same as cad_slice1/2/3).
-- Applied via psql, then `prisma migrate resolve --applied`.
--
-- Idempotent: IF NOT EXISTS / DROP CONSTRAINT IF EXISTS guards throughout,
-- so a re-apply is a no-op. Pre-existing schema↔DB drift from earlier slices
-- deliberately NOT touched here.

-- CadBomLine → CadPart link (SetNull on part delete). Added after the
-- cad_parts table is created below.
ALTER TABLE "cad_bom_lines" ADD COLUMN IF NOT EXISTS "inventory_part_id" TEXT;
CREATE INDEX IF NOT EXISTS "cad_bom_lines_inventory_part_id_idx" ON "cad_bom_lines"("inventory_part_id");

-- Parts inventory catalog (tenant-scoped).
CREATE TABLE IF NOT EXISTS "cad_parts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "category" TEXT NOT NULL DEFAULT 'other',
    "on_hand_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reorder_point" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit_of_measure" TEXT NOT NULL DEFAULT 'pcs',
    "storage_location" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cad_parts_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_parts" DROP CONSTRAINT IF EXISTS "cad_parts_workspace_id_fkey";
ALTER TABLE "cad_parts" ADD CONSTRAINT "cad_parts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_parts_workspace_id_idx" ON "cad_parts"("workspace_id");
CREATE INDEX IF NOT EXISTS "cad_parts_workspace_id_category_idx" ON "cad_parts"("workspace_id", "category");

-- Auditable stock events (append-only; who/when/delta/reason).
CREATE TABLE IF NOT EXISTS "cad_stock_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "part_id" TEXT NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "quantity_after" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_stock_events_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_stock_events" DROP CONSTRAINT IF EXISTS "cad_stock_events_workspace_id_fkey";
ALTER TABLE "cad_stock_events" ADD CONSTRAINT "cad_stock_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_stock_events" DROP CONSTRAINT IF EXISTS "cad_stock_events_part_id_fkey";
ALTER TABLE "cad_stock_events" ADD CONSTRAINT "cad_stock_events_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "cad_parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_stock_events_workspace_id_part_id_idx" ON "cad_stock_events"("workspace_id", "part_id");

-- Suppliers.
CREATE TABLE IF NOT EXISTS "cad_suppliers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "lead_time" TEXT,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cad_suppliers_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_suppliers" DROP CONSTRAINT IF EXISTS "cad_suppliers_workspace_id_fkey";
ALTER TABLE "cad_suppliers" ADD CONSTRAINT "cad_suppliers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_suppliers_workspace_id_idx" ON "cad_suppliers"("workspace_id");

-- Part ↔ supplier links with quoted-cost sourcing. Quote figures cite
-- their source; a link with no quote carries no cost (never invented).
CREATE TABLE IF NOT EXISTS "cad_part_suppliers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "part_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "quoted_unit_cost" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "quoted_date" TIMESTAMP(3),
    "quote_source" TEXT,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cad_part_suppliers_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_part_suppliers" DROP CONSTRAINT IF EXISTS "cad_part_suppliers_workspace_id_fkey";
ALTER TABLE "cad_part_suppliers" ADD CONSTRAINT "cad_part_suppliers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_part_suppliers" DROP CONSTRAINT IF EXISTS "cad_part_suppliers_part_id_fkey";
ALTER TABLE "cad_part_suppliers" ADD CONSTRAINT "cad_part_suppliers_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "cad_parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_part_suppliers" DROP CONSTRAINT IF EXISTS "cad_part_suppliers_supplier_id_fkey";
ALTER TABLE "cad_part_suppliers" ADD CONSTRAINT "cad_part_suppliers_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "cad_suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_part_suppliers_workspace_id_part_id_idx" ON "cad_part_suppliers"("workspace_id", "part_id");
CREATE UNIQUE INDEX IF NOT EXISTS "cad_part_suppliers_part_id_supplier_id_key" ON "cad_part_suppliers"("part_id", "supplier_id");

-- Revision-linked tasks/issues. The version pin is a reference only —
-- closing/editing a task never mutates the immutable version row.
CREATE TABLE IF NOT EXISTS "cad_tasks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "model_version_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'task',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "assignee" TEXT,
    "due_date" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "closed_by" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cad_tasks_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_tasks" DROP CONSTRAINT IF EXISTS "cad_tasks_workspace_id_fkey";
ALTER TABLE "cad_tasks" ADD CONSTRAINT "cad_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_tasks" DROP CONSTRAINT IF EXISTS "cad_tasks_project_id_fkey";
ALTER TABLE "cad_tasks" ADD CONSTRAINT "cad_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "cad_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_tasks" DROP CONSTRAINT IF EXISTS "cad_tasks_model_version_id_fkey";
ALTER TABLE "cad_tasks" ADD CONSTRAINT "cad_tasks_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "cad_model_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_tasks_workspace_id_project_id_idx" ON "cad_tasks"("workspace_id", "project_id");
CREATE INDEX IF NOT EXISTS "cad_tasks_workspace_id_status_idx" ON "cad_tasks"("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "cad_tasks_model_version_id_idx" ON "cad_tasks"("model_version_id");

-- Task comments + activity trail (append-only; system events recorded here).
CREATE TABLE IF NOT EXISTS "cad_task_comments" (    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "event_kind" TEXT NOT NULL DEFAULT 'comment',
    "body" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "event_meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_task_comments_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_task_comments" DROP CONSTRAINT IF EXISTS "cad_task_comments_workspace_id_fkey";
ALTER TABLE "cad_task_comments" ADD CONSTRAINT "cad_task_comments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_task_comments" DROP CONSTRAINT IF EXISTS "cad_task_comments_task_id_fkey";
ALTER TABLE "cad_task_comments" ADD CONSTRAINT "cad_task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "cad_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_task_comments_workspace_id_task_id_idx" ON "cad_task_comments"("workspace_id", "task_id");

-- CadBomLine → CadPart foreign key, added after cad_parts exists.
ALTER TABLE "cad_bom_lines" DROP CONSTRAINT IF EXISTS "cad_bom_lines_inventory_part_id_fkey";
ALTER TABLE "cad_bom_lines" ADD CONSTRAINT "cad_bom_lines_inventory_part_id_fkey" FOREIGN KEY ("inventory_part_id") REFERENCES "cad_parts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
