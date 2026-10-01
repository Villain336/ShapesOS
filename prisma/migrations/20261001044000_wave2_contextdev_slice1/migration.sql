-- Wave 2 context.dev slice 1: daily credit-budget table.
-- One row per workspace per UTC day (day = YYYY-MM-DD). recordSpend charges
-- atomically via upsert+increment; the gate (decideBudget) runs before any
-- Context.dev API call. Over-budget calls route to approval, never charge.

-- CreateTable
CREATE TABLE "context_dev_budgets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "credits_used" INTEGER NOT NULL DEFAULT 0,
    "cap_credits" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "context_dev_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "context_dev_budgets_workspace_id_idx" ON "context_dev_budgets"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "context_dev_budgets_workspace_id_day_key" ON "context_dev_budgets"("workspace_id", "day");

-- AddForeignKey
ALTER TABLE "context_dev_budgets" ADD CONSTRAINT "context_dev_budgets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
