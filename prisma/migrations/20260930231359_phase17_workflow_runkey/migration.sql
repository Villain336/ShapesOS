-- Phase 17 slice 6: workflow run idempotency key.
-- One run per (workspace_id, run_key): an approved workflow plan can never
-- execute twice (the replay lock for pre-authorized rollback). NULL run_key
-- rows (pre-slice-6) are unaffected — Postgres treats NULLs as distinct in
-- unique indexes. RLS policy on ops_workflow_runs is unchanged.
ALTER TABLE "ops_workflow_runs" ADD COLUMN "run_key" TEXT;

CREATE UNIQUE INDEX "ops_workflow_runs_workspace_id_run_key_key"
  ON "ops_workflow_runs"("workspace_id", "run_key");
