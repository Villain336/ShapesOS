-- Drift reconciliation, part 2 (2026-09-26).
-- Normalizes the billing_topup_idempotency FK (adopted in
-- 20260926180000_drift_reconciliation) to Prisma's canonical form with an
-- explicit ON UPDATE NO ACTION clause. The pre-existing constraint created
-- by the runtime DDL in lib/metering/billing.ts is semantically identical
-- (Postgres defaults ON UPDATE to NO ACTION); this only aligns the
-- definition so schema<->DB diffs stay quiet. Zero data risk:
-- constraint-only change, and the table is empty on the preview DB.
ALTER TABLE "billing_topup_idempotency" DROP CONSTRAINT "billing_topup_idempotency_workspace_id_fkey";
ALTER TABLE "billing_topup_idempotency" ADD CONSTRAINT "billing_topup_idempotency_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
