-- ShapesOS Phase 14 (connectors): a pay run handed to a payroll provider
-- (Gusto). One row per (run, provider): sent → synced → paid
-- (lib/bizsync/gusto/payroll.ts). The pay run itself and its posted journal
-- entry keep their own guards (ops_pay_runs_lifecycle, ops_payslips_frozen);
-- this table only records the provider side. FORCE RLS on app.workspace_id;
-- cascades from the workspace and from the run.

-- CreateTable
CREATE TABLE "ops_pay_run_provider_syncs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "pay_run_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "remote_payroll_id" TEXT,
    "sent_digest" TEXT,
    "sent_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "remote_check_date" DATE,
    "payment_entry_id" TEXT,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "sent_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_pay_run_provider_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ops_pay_run_provider_syncs_workspace_id_provider_status_idx" ON "ops_pay_run_provider_syncs"("workspace_id", "provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ops_pay_run_provider_syncs_pay_run_id_provider_key" ON "ops_pay_run_provider_syncs"("pay_run_id", "provider");

-- AddForeignKey
ALTER TABLE "ops_pay_run_provider_syncs" ADD CONSTRAINT "ops_pay_run_provider_syncs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_pay_run_provider_syncs" ADD CONSTRAINT "ops_pay_run_provider_syncs_pay_run_id_fkey" FOREIGN KEY ("pay_run_id") REFERENCES "ops_pay_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "ops_pay_run_provider_syncs" ADD CONSTRAINT "ops_pay_run_provider_syncs_state_chk" CHECK (
  "provider" IN ('gusto')
  AND "status" IN ('sent', 'synced', 'paid')
  AND ("status" <> 'sent' OR ("sent_at" IS NOT NULL AND "sent_digest" IS NOT NULL AND "remote_payroll_id" IS NOT NULL))
  AND ("status" NOT IN ('synced', 'paid') OR "synced_at" IS NOT NULL)
  AND ("status" <> 'paid' OR "paid_at" IS NOT NULL)
  AND ("payment_entry_id" IS NULL OR "status" = 'paid')
);

-- Row-level security: fail-closed tenant isolation.
ALTER TABLE "ops_pay_run_provider_syncs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ops_pay_run_provider_syncs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ops_pay_run_provider_syncs_tenant_isolation" ON "ops_pay_run_provider_syncs" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
