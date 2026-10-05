-- ShapesOS Phase 12 (people): payroll — salary structures (rules engine),
-- effective-dated assignments to team members, pay runs and payslips.
-- Pay runs move draft → computed → approved → posted; approving and posting
-- are gated Tier-3 money writes and posting goes through the Phase 10
-- journal (lib/ops/payroll). The database holds the lines that matter:
--   * a run can't be approved/posted without an approval record, nor posted
--     without its journal entry;
--   * payslip and run totals reconcile (net = gross − deductions − taxes);
--   * payslips of an approved or posted run are frozen.
-- Every table is FORCE RLS on the app.workspace_id GUC and cascades from
-- workspaces.

-- CreateEnum
CREATE TYPE "OpsPayRunStatus" AS ENUM ('draft', 'computed', 'approved', 'posted', 'cancelled');

-- CreateTable
CREATE TABLE "ops_salary_structures" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pay_type" TEXT NOT NULL DEFAULT 'salary',
    "pay_frequency" TEXT NOT NULL DEFAULT 'biweekly',
    "annual_salary_cents" INTEGER,
    "hourly_rate_cents" INTEGER,
    "overtime_enabled" BOOLEAN NOT NULL DEFAULT true,
    "overtime_threshold_minutes" INTEGER NOT NULL DEFAULT 2400,
    "overtime_multiplier_bps" INTEGER NOT NULL DEFAULT 15000,
    "components" JSONB NOT NULL DEFAULT '[]',
    "country" TEXT NOT NULL DEFAULT 'US',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "ops_salary_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_salary_assignments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "structure_id" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "annual_salary_cents" INTEGER,
    "hourly_rate_cents" INTEGER,
    "filing_status" TEXT NOT NULL DEFAULT 'single',
    "w4_step2" BOOLEAN NOT NULL DEFAULT false,
    "dependents_credit_cents" INTEGER NOT NULL DEFAULT 0,
    "other_income_cents" INTEGER NOT NULL DEFAULT 0,
    "deductions_cents" INTEGER NOT NULL DEFAULT 0,
    "extra_withholding_cents" INTEGER NOT NULL DEFAULT 0,
    "state_code" TEXT,
    "state_rate_bps" INTEGER,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "ops_salary_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_pay_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "number" TEXT,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "pay_date" DATE NOT NULL,
    "status" "OpsPayRunStatus" NOT NULL DEFAULT 'draft',
    "gross_cents" INTEGER NOT NULL DEFAULT 0,
    "employee_tax_cents" INTEGER NOT NULL DEFAULT 0,
    "deduction_cents" INTEGER NOT NULL DEFAULT 0,
    "net_cents" INTEGER NOT NULL DEFAULT 0,
    "employer_tax_cents" INTEGER NOT NULL DEFAULT 0,
    "employer_contrib_cents" INTEGER NOT NULL DEFAULT 0,
    "payslip_count" INTEGER NOT NULL DEFAULT 0,
    "compute_digest" TEXT,
    "computed_at" TIMESTAMP(3),
    "approval_id" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "posted_at" TIMESTAMP(3),
    "journal_entry_id" TEXT,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "ops_pay_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_payslips" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "pay_run_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "member_name" TEXT NOT NULL,
    "assignment_id" TEXT,
    "structure_name" TEXT NOT NULL,
    "pay_type" TEXT NOT NULL,
    "regular_minutes" INTEGER NOT NULL DEFAULT 0,
    "overtime_minutes" INTEGER NOT NULL DEFAULT 0,
    "gross_cents" INTEGER NOT NULL,
    "pre_tax_deduction_cents" INTEGER NOT NULL,
    "taxable_wages_cents" INTEGER NOT NULL,
    "employee_tax_cents" INTEGER NOT NULL,
    "post_tax_deduction_cents" INTEGER NOT NULL,
    "net_cents" INTEGER NOT NULL,
    "employer_tax_cents" INTEGER NOT NULL,
    "employer_contrib_cents" INTEGER NOT NULL,
    "ss_wages_cents" INTEGER NOT NULL DEFAULT 0,
    "medicare_wages_cents" INTEGER NOT NULL DEFAULT 0,
    "futa_wages_cents" INTEGER NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL,
    "tax_table" TEXT NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "ops_payslips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_salary_structures_workspace_id_name_key" ON "ops_salary_structures"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "ops_salary_assignments_workspace_id_member_id_effective_fro_idx" ON "ops_salary_assignments"("workspace_id", "member_id", "effective_from");

-- CreateIndex
CREATE INDEX "ops_salary_assignments_workspace_id_structure_id_idx" ON "ops_salary_assignments"("workspace_id", "structure_id");

-- CreateIndex
CREATE INDEX "ops_pay_runs_workspace_id_status_period_end_idx" ON "ops_pay_runs"("workspace_id", "status", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "ops_pay_runs_workspace_id_number_key" ON "ops_pay_runs"("workspace_id", "number");

-- CreateIndex
CREATE INDEX "ops_payslips_workspace_id_member_id_created_at_idx" ON "ops_payslips"("workspace_id", "member_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ops_payslips_pay_run_id_member_id_key" ON "ops_payslips"("pay_run_id", "member_id");

-- AddForeignKey
ALTER TABLE "ops_salary_structures" ADD CONSTRAINT "ops_salary_structures_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_salary_assignments" ADD CONSTRAINT "ops_salary_assignments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_salary_assignments" ADD CONSTRAINT "ops_salary_assignments_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "ops_team_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_salary_assignments" ADD CONSTRAINT "ops_salary_assignments_structure_id_fkey" FOREIGN KEY ("structure_id") REFERENCES "ops_salary_structures"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_pay_runs" ADD CONSTRAINT "ops_pay_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_payslips" ADD CONSTRAINT "ops_payslips_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_payslips" ADD CONSTRAINT "ops_payslips_pay_run_id_fkey" FOREIGN KEY ("pay_run_id") REFERENCES "ops_pay_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_payslips" ADD CONSTRAINT "ops_payslips_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "ops_team_members"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Money and lifecycle guards.
ALTER TABLE "ops_salary_structures" ADD CONSTRAINT "ops_salary_structures_pay_chk" CHECK (
  "pay_type" IN ('salary', 'hourly')
  AND "pay_frequency" IN ('weekly', 'biweekly', 'semimonthly', 'monthly')
  AND ("annual_salary_cents" IS NULL OR "annual_salary_cents" >= 0)
  AND ("hourly_rate_cents" IS NULL OR "hourly_rate_cents" >= 0)
  AND "overtime_threshold_minutes" > 0
  AND "overtime_multiplier_bps" >= 10000
);
ALTER TABLE "ops_salary_assignments" ADD CONSTRAINT "ops_salary_assignments_chk" CHECK (
  ("effective_to" IS NULL OR "effective_to" >= "effective_from")
  AND "filing_status" IN ('single', 'married_jointly', 'head_of_household')
  AND "dependents_credit_cents" >= 0 AND "other_income_cents" >= 0
  AND "deductions_cents" >= 0 AND "extra_withholding_cents" >= 0
  AND ("state_rate_bps" IS NULL OR ("state_rate_bps" >= 0 AND "state_rate_bps" <= 2000))
  AND ("state_code" IS NULL OR "state_code" ~ '^[A-Z]{2}$')
);
ALTER TABLE "ops_pay_runs" ADD CONSTRAINT "ops_pay_runs_period_chk" CHECK ("period_end" >= "period_start");
ALTER TABLE "ops_pay_runs" ADD CONSTRAINT "ops_pay_runs_totals_chk" CHECK (
  "gross_cents" >= 0 AND "employee_tax_cents" >= 0 AND "deduction_cents" >= 0 AND "net_cents" >= 0
  AND "employer_tax_cents" >= 0 AND "employer_contrib_cents" >= 0
  AND "net_cents" = "gross_cents" - "employee_tax_cents" - "deduction_cents"
);
-- No approval, no approved/posted run; no journal entry, no posted run.
ALTER TABLE "ops_pay_runs" ADD CONSTRAINT "ops_pay_runs_approval_chk" CHECK (
  "status" NOT IN ('approved', 'posted')
  OR ("approval_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by" IS NOT NULL)
);
ALTER TABLE "ops_pay_runs" ADD CONSTRAINT "ops_pay_runs_posted_chk" CHECK (
  "status" <> 'posted' OR ("journal_entry_id" IS NOT NULL AND "posted_at" IS NOT NULL)
);
ALTER TABLE "ops_payslips" ADD CONSTRAINT "ops_payslips_totals_chk" CHECK (
  "gross_cents" >= 0 AND "pre_tax_deduction_cents" >= 0 AND "employee_tax_cents" >= 0
  AND "post_tax_deduction_cents" >= 0 AND "net_cents" >= 0
  AND "employer_tax_cents" >= 0 AND "employer_contrib_cents" >= 0
  AND "taxable_wages_cents" = "gross_cents" - "pre_tax_deduction_cents"
  AND "net_cents" = "gross_cents" - "pre_tax_deduction_cents" - "employee_tax_cents" - "post_tax_deduction_cents"
);

-- Payslips of an approved or posted run are frozen (inserts and updates
-- refused; deletes stay possible so workspace erasure can cascade).
CREATE OR REPLACE FUNCTION ops_payslips_frozen() RETURNS trigger AS $$
DECLARE
  run_status TEXT;
BEGIN
  SELECT "status"::text INTO run_status FROM "ops_pay_runs" WHERE "id" = NEW."pay_run_id";
  IF run_status IN ('approved', 'posted') THEN
    RAISE EXCEPTION 'payslips of an % pay run are frozen', run_status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ops_payslips_frozen_trg"
  BEFORE INSERT OR UPDATE ON "ops_payslips"
  FOR EACH ROW EXECUTE FUNCTION ops_payslips_frozen();

-- Row-level security: fail-closed tenant isolation.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_salary_structures', 'ops_salary_assignments', 'ops_pay_runs', 'ops_payslips'] LOOP
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
