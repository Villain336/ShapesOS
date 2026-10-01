-- Wave 2 quick wins — WFH mode module, slice 6 (SPEC-WFH-MODE.md).
-- Home-office expense pack: pre-wired categories with allocation rules
-- (flat % or square footage) + deductible computation. A category pack and
-- allocation engine, not a full expense product; a finance ledger consumes
-- rows via the toLedgerEntry post hook.

CREATE TABLE "wfh_expense_categories" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "allocation_method" TEXT NOT NULL DEFAULT 'flat_percent',
  "allocation_pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "office_sqft" DOUBLE PRECISION,
  "total_sqft" DOUBLE PRECISION,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_expense_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wfh_expense_categories_workspace_id_user_id_key_key" ON "wfh_expense_categories"("workspace_id", "user_id", "key");
ALTER TABLE "wfh_expense_categories" ADD CONSTRAINT "wfh_expense_categories_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "wfh_expenses" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "category_id" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "occurred_on" TIMESTAMPTZ(6) NOT NULL,
  "allocation_method" TEXT NOT NULL,
  "allocation_pct" DOUBLE PRECISION NOT NULL,
  "deductible_cents" INTEGER NOT NULL,
  "note" TEXT,
  "receipt_url" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wfh_expenses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "wfh_expenses_workspace_id_user_id_occurred_on_idx" ON "wfh_expenses"("workspace_id", "user_id", "occurred_on");
ALTER TABLE "wfh_expenses" ADD CONSTRAINT "wfh_expenses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wfh_expenses" ADD CONSTRAINT "wfh_expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "wfh_expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
