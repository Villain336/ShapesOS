-- CAD + Hardware slice 3: prototype pipeline — rate cards, BOMs pinned to
-- model versions, cost estimates, vendor export / quote requests.
--
-- Hand-authored (migrate dev is broken on this box: the pgserver-bundled PG
-- lacks pgcrypto contrib files for the shadow DB — same as cad_slice1/2).
-- Applied via psql, then `prisma migrate resolve --applied`.
--
-- Idempotent: IF NOT EXISTS / DROP CONSTRAINT IF EXISTS guards throughout,
-- so a re-apply is a no-op. Pre-existing schema↔DB drift from earlier slices
-- deliberately NOT touched here.
--
-- v1 boundary (also in lib/cad/prototype.ts): NO live vendor APIs. A quote
-- request is draft → confirmed → sent; "sent" only records the tenant's own
-- transmission (who, when, to whom, via which connected account). v1 does
-- not place orders.

-- Rate cards: tenant-configurable process pricing for cost estimates.
CREATE TABLE IF NOT EXISTS "cad_rate_cards" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "process" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "rates" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_rate_cards_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_rate_cards" DROP CONSTRAINT IF EXISTS "cad_rate_cards_workspace_id_fkey";
ALTER TABLE "cad_rate_cards" ADD CONSTRAINT "cad_rate_cards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_rate_cards_workspace_id_process_idx" ON "cad_rate_cards"("workspace_id", "process");

-- BOM versions, pinned to one immutable model version each.
CREATE TABLE IF NOT EXISTS "cad_bom_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "model_version_id" TEXT NOT NULL,
    "bom_number" INTEGER NOT NULL,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_bom_versions_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_bom_versions" DROP CONSTRAINT IF EXISTS "cad_bom_versions_workspace_id_fkey";
ALTER TABLE "cad_bom_versions" ADD CONSTRAINT "cad_bom_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_bom_versions" DROP CONSTRAINT IF EXISTS "cad_bom_versions_model_id_fkey";
ALTER TABLE "cad_bom_versions" ADD CONSTRAINT "cad_bom_versions_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "cad_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_bom_versions" DROP CONSTRAINT IF EXISTS "cad_bom_versions_model_version_id_fkey";
ALTER TABLE "cad_bom_versions" ADD CONSTRAINT "cad_bom_versions_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "cad_model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'cad_bom_versions_model_id_bom_number_key'
    ) THEN
        ALTER TABLE "cad_bom_versions" ADD CONSTRAINT "cad_bom_versions_model_id_bom_number_key" UNIQUE ("model_id", "bom_number");
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS "cad_bom_versions_workspace_id_model_id_idx" ON "cad_bom_versions"("workspace_id", "model_id");

-- BOM line items. v1: source is "manual" (derived: rejected by the store).
CREATE TABLE IF NOT EXISTS "cad_bom_lines" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "bom_version_id" TEXT NOT NULL,
    "part_name" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit_name" TEXT NOT NULL DEFAULT 'pcs',
    "material_spec" TEXT,
    "supplier" TEXT,
    "unit_cost_usd" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_bom_lines_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_bom_lines" DROP CONSTRAINT IF EXISTS "cad_bom_lines_workspace_id_fkey";
ALTER TABLE "cad_bom_lines" ADD CONSTRAINT "cad_bom_lines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_bom_lines" DROP CONSTRAINT IF EXISTS "cad_bom_lines_bom_version_id_fkey";
ALTER TABLE "cad_bom_lines" ADD CONSTRAINT "cad_bom_lines_bom_version_id_fkey" FOREIGN KEY ("bom_version_id") REFERENCES "cad_bom_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_bom_lines_bom_version_id_sort_order_idx" ON "cad_bom_lines"("bom_version_id", "sort_order");

-- Cost estimates: labeled estimates (never vendor quotes) pinned to
-- (model version, BOM version, rate card).
CREATE TABLE IF NOT EXISTS "cad_cost_estimates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "model_version_id" TEXT NOT NULL,
    "bom_version_id" TEXT NOT NULL,
    "rate_card_id" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "bom_total_usd" DOUBLE PRECISION NOT NULL,
    "process_cost_usd" DOUBLE PRECISION NOT NULL,
    "grand_total_usd" DOUBLE PRECISION NOT NULL,
    "per_unit_usd" DOUBLE PRECISION,
    "basis" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_cost_estimates_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_cost_estimates" DROP CONSTRAINT IF EXISTS "cad_cost_estimates_workspace_id_fkey";
ALTER TABLE "cad_cost_estimates" ADD CONSTRAINT "cad_cost_estimates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_cost_estimates" DROP CONSTRAINT IF EXISTS "cad_cost_estimates_model_version_id_fkey";
ALTER TABLE "cad_cost_estimates" ADD CONSTRAINT "cad_cost_estimates_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "cad_model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_cost_estimates" DROP CONSTRAINT IF EXISTS "cad_cost_estimates_bom_version_id_fkey";
ALTER TABLE "cad_cost_estimates" ADD CONSTRAINT "cad_cost_estimates_bom_version_id_fkey" FOREIGN KEY ("bom_version_id") REFERENCES "cad_bom_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cad_cost_estimates" DROP CONSTRAINT IF EXISTS "cad_cost_estimates_rate_card_id_fkey";
ALTER TABLE "cad_cost_estimates" ADD CONSTRAINT "cad_cost_estimates_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "cad_rate_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_cost_estimates_workspace_id_model_version_id_idx" ON "cad_cost_estimates"("workspace_id", "model_version_id");

-- Export / quote requests: draft → confirmed → sent.
CREATE TABLE IF NOT EXISTS "cad_export_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "model_version_id" TEXT NOT NULL,
    "process" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "process_options" JSONB NOT NULL DEFAULT '{}',
    "contact" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "manifest_path" TEXT,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "sent_by" TEXT,
    "sent_at" TIMESTAMP(3),
    "recipient" TEXT,
    "sent_via_account" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cad_export_requests_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "cad_export_requests" DROP CONSTRAINT IF EXISTS "cad_export_requests_workspace_id_fkey";
ALTER TABLE "cad_export_requests" ADD CONSTRAINT "cad_export_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_export_requests" DROP CONSTRAINT IF EXISTS "cad_export_requests_model_id_fkey";
ALTER TABLE "cad_export_requests" ADD CONSTRAINT "cad_export_requests_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "cad_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cad_export_requests" DROP CONSTRAINT IF EXISTS "cad_export_requests_model_version_id_fkey";
ALTER TABLE "cad_export_requests" ADD CONSTRAINT "cad_export_requests_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "cad_model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "cad_export_requests_workspace_id_model_id_idx" ON "cad_export_requests"("workspace_id", "model_id");
