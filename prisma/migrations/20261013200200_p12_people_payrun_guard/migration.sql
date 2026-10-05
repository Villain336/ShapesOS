-- ShapesOS Phase 12 (people): the pay-run lifecycle, enforced by the
-- database (lib/ops/payroll/runs.ts is the only writer; this is the
-- backstop that holds even against a buggy or hostile caller):
--   * only a COMPUTED run can become approved, and only an APPROVED run can
--     be posted (the CHECKs in 20261013200000 already demand the approval
--     record and the journal entry for those states);
--   * once approved, the totals, the compute digest and the approval are
--     frozen (recomputing would change what the approver saw);
--   * posted and cancelled runs are final.
-- Deletes stay possible so workspace erasure can cascade.

CREATE OR REPLACE FUNCTION ops_pay_runs_lifecycle() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('posted', 'cancelled') THEN
    RAISE EXCEPTION 'a % pay run is final', OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'approved' AND OLD."status" NOT IN ('computed', 'approved') THEN
    RAISE EXCEPTION 'only a computed pay run can be approved (it is %)', OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'posted' AND OLD."status" <> 'approved' THEN
    RAISE EXCEPTION 'only an approved pay run can be posted (it is %)', OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'approved' AND (
       NEW."status" NOT IN ('approved', 'posted', 'cancelled')
    OR NEW."gross_cents" <> OLD."gross_cents"
    OR NEW."employee_tax_cents" <> OLD."employee_tax_cents"
    OR NEW."deduction_cents" <> OLD."deduction_cents"
    OR NEW."net_cents" <> OLD."net_cents"
    OR NEW."employer_tax_cents" <> OLD."employer_tax_cents"
    OR NEW."employer_contrib_cents" <> OLD."employer_contrib_cents"
    OR NEW."payslip_count" <> OLD."payslip_count"
    OR NEW."compute_digest" IS DISTINCT FROM OLD."compute_digest"
    OR NEW."approval_id" IS DISTINCT FROM OLD."approval_id"
    OR NEW."period_start" <> OLD."period_start"
    OR NEW."period_end" <> OLD."period_end"
    OR NEW."pay_date" <> OLD."pay_date"
  ) THEN
    RAISE EXCEPTION 'an approved pay run is frozen (only posting or cancelling it is allowed)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ops_pay_runs_lifecycle_trg"
  BEFORE UPDATE ON "ops_pay_runs"
  FOR EACH ROW EXECUTE FUNCTION ops_pay_runs_lifecycle();
