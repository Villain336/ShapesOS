-- ShapesOS Phase 12 (mfgpos): POINT OF SALE on the Ops layer.
--
--   ops_pos_registers   a till: stock location, tax rate, Stripe Terminal
--                       reader id
--   ops_pos_sessions    open (opening float) → closing (cash counted) →
--                       closed (one balanced journal entry, Tier 3);
--                       ONE open/closing session per register
--   ops_orders          + pos_session_id, + client_order_id (unique per
--                       workspace → the offline queue's replay is a no-op)
--
-- A sale is an ops_orders row (source 'pos') with ops_payments rows (cash /
-- card) — no parallel order model. Both new tables are FORCE RLS on
-- app.workspace_id and cascade from workspaces.

-- CreateEnum
CREATE TYPE "OpsPosSessionStatus" AS ENUM ('open', 'closing', 'closed');

-- AlterTable
ALTER TABLE "ops_orders" ADD COLUMN     "client_order_id" TEXT,
ADD COLUMN     "pos_session_id" TEXT;

-- CreateTable
CREATE TABLE "ops_pos_registers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location_id" TEXT,
    "tax_rate_id" TEXT,
    "terminal_reader_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_pos_registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_pos_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "register_id" TEXT NOT NULL,
    "number" TEXT,
    "status" "OpsPosSessionStatus" NOT NULL DEFAULT 'open',
    "opened_by" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_cash_cents" INTEGER NOT NULL,
    "counted_cash_cents" INTEGER,
    "counted_by" TEXT,
    "counted_at" TIMESTAMP(3),
    "expected_cash_cents" INTEGER,
    "cash_difference_cents" INTEGER,
    "order_count" INTEGER NOT NULL DEFAULT 0,
    "net_sales_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "cash_sales_cents" INTEGER NOT NULL DEFAULT 0,
    "card_sales_cents" INTEGER NOT NULL DEFAULT 0,
    "journal_entry_id" TEXT,
    "closed_by" TEXT,
    "closed_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_pos_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_pos_registers_workspace_id_name_key" ON "ops_pos_registers"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "ops_pos_sessions_workspace_id_register_id_status_idx" ON "ops_pos_sessions"("workspace_id", "register_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ops_pos_sessions_workspace_id_number_key" ON "ops_pos_sessions"("workspace_id", "number");

-- CreateIndex
CREATE INDEX "ops_orders_workspace_id_pos_session_id_idx" ON "ops_orders"("workspace_id", "pos_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_orders_workspace_id_client_order_id_key" ON "ops_orders"("workspace_id", "client_order_id");

-- AddForeignKey
ALTER TABLE "ops_orders" ADD CONSTRAINT "ops_orders_pos_session_id_fkey" FOREIGN KEY ("pos_session_id") REFERENCES "ops_pos_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_pos_registers" ADD CONSTRAINT "ops_pos_registers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_pos_registers" ADD CONSTRAINT "ops_pos_registers_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "ops_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_pos_sessions" ADD CONSTRAINT "ops_pos_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_pos_sessions" ADD CONSTRAINT "ops_pos_sessions_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "ops_pos_registers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One open (or closing) session per register at a time.
CREATE UNIQUE INDEX "ops_pos_sessions_one_open_per_register"
  ON "ops_pos_sessions" ("register_id")
  WHERE "status" <> 'closed';

ALTER TABLE "ops_pos_sessions" ADD CONSTRAINT "ops_pos_sessions_money_chk"
  CHECK ("opening_cash_cents" >= 0 AND ("counted_cash_cents" IS NULL OR "counted_cash_cents" >= 0)
         AND "order_count" >= 0 AND "net_sales_cents" >= 0 AND "discount_cents" >= 0
         AND "tax_cents" >= 0 AND "cash_sales_cents" >= 0 AND "card_sales_cents" >= 0);
ALTER TABLE "ops_pos_sessions" ADD CONSTRAINT "ops_pos_sessions_closed_chk"
  CHECK ("status" <> 'closed' OR ("counted_cash_cents" IS NOT NULL AND "closed_at" IS NOT NULL));

-- Row-level security: fail-closed tenant isolation.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_pos_registers', 'ops_pos_sessions'] LOOP
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
