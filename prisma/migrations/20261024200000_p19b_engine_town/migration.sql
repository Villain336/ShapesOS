-- ShapesOS Phase 19B (WS=engine): Dress Rehearsal — town mode (lib/sim,
-- commercial layer, entitlement dress_rehearsal).
-- sim_worlds (layout JSON + source: generated | figma), sim_runs (scenario,
-- seed, N, status, cap, spend, report), sim_residents, sim_events (the
-- APPEND-ONLY event log) and sim_snapshots (one per sim-hour, for seeking).
-- Every table cascades from workspaces and is FORCE RLS on the
-- app.workspace_id GUC (fail-closed: no GUC = zero rows).

-- CreateTable
CREATE TABLE "sim_worlds" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "seed" INTEGER,
    "size" TEXT,
    "figma_file_key" TEXT,
    "figma_node_id" TEXT,
    "layout" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sim_worlds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sim_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "world_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "mode" TEXT NOT NULL DEFAULT 'live',
    "scenario_a" JSONB NOT NULL,
    "scenario_b" JSONB,
    "population" INTEGER NOT NULL,
    "segments" JSONB NOT NULL,
    "persona_snapshot" JSONB NOT NULL,
    "days" INTEGER NOT NULL,
    "seeds" INTEGER NOT NULL,
    "base_seed" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "model_kind" TEXT NOT NULL DEFAULT 'live',
    "estimate" JSONB NOT NULL,
    "estimate_credits" INTEGER NOT NULL,
    "cap_credits" INTEGER NOT NULL,
    "spent_credits" INTEGER NOT NULL DEFAULT 0,
    "call_count" INTEGER NOT NULL DEFAULT 0,
    "cache_hits" INTEGER NOT NULL DEFAULT 0,
    "stop_reason" TEXT,
    "stopped_at" JSONB,
    "progress" JSONB,
    "report" JSONB,
    "event_hashes" JSONB,
    "export_ref" TEXT,
    "replay_of" TEXT,
    "job_id" TEXT,
    "confirmed_by" TEXT NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sim_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sim_residents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "resident_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "persona_id" TEXT,
    "calibrated" BOOLEAN NOT NULL DEFAULT false,
    "home_lot_id" TEXT NOT NULL,
    "work_lot_id" TEXT NOT NULL,
    "routine" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "sim_residents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sim_events" (
    "id" BIGSERIAL NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "seed_index" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "t" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "resident_key" TEXT,
    "lot_id" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sim_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sim_snapshots" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "seed_index" INTEGER NOT NULL,
    "hour" INTEGER NOT NULL,
    "t" INTEGER NOT NULL,
    "state" JSONB NOT NULL,

    CONSTRAINT "sim_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sim_worlds_workspace_id_created_at_idx" ON "sim_worlds"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "sim_runs_workspace_id_created_at_idx" ON "sim_runs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "sim_runs_workspace_id_status_idx" ON "sim_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "sim_residents_workspace_id_run_id_idx" ON "sim_residents"("workspace_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "sim_residents_run_id_resident_key_key" ON "sim_residents"("run_id", "resident_key");

-- CreateIndex
CREATE INDEX "sim_events_run_id_variant_seed_index_t_idx" ON "sim_events"("run_id", "variant", "seed_index", "t");

-- CreateIndex
CREATE INDEX "sim_events_workspace_id_run_id_idx" ON "sim_events"("workspace_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "sim_events_run_id_variant_seed_index_seq_key" ON "sim_events"("run_id", "variant", "seed_index", "seq");

-- CreateIndex
CREATE INDEX "sim_snapshots_workspace_id_run_id_idx" ON "sim_snapshots"("workspace_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "sim_snapshots_run_id_variant_seed_index_hour_key" ON "sim_snapshots"("run_id", "variant", "seed_index", "hour");

-- AddForeignKey
ALTER TABLE "sim_worlds" ADD CONSTRAINT "sim_worlds_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_runs" ADD CONSTRAINT "sim_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_runs" ADD CONSTRAINT "sim_runs_world_id_fkey" FOREIGN KEY ("world_id") REFERENCES "sim_worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_residents" ADD CONSTRAINT "sim_residents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_residents" ADD CONSTRAINT "sim_residents_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sim_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_events" ADD CONSTRAINT "sim_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_events" ADD CONSTRAINT "sim_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sim_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_snapshots" ADD CONSTRAINT "sim_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_snapshots" ADD CONSTRAINT "sim_snapshots_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sim_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-4a / 18.x / 19B panel migrations.
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sim_worlds', 'sim_runs', 'sim_residents', 'sim_events', 'sim_snapshots'] LOOP
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

-- ============================================================
-- sim_events is APPEND-ONLY for every role but its owner (the migrator):
-- no UPDATE / DELETE grants (default privileges may have granted them to the
-- app role when the table was created). Rows still go with their run or
-- workspace: the FK cascade runs as the table owner. The same REVOKE runs in
-- scripts/db/create-app-role.sql, which re-grants on every table.
-- ============================================================
REVOKE UPDATE, DELETE, TRUNCATE ON "sim_events" FROM PUBLIC;
DO $$
DECLARE
  r TEXT;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'sim_events'
       AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
       AND grantee NOT IN (current_user, 'PUBLIC')
       AND grantee NOT IN (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'sim_events')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM %I', 'sim_events', r);
  END LOOP;
END $$;
