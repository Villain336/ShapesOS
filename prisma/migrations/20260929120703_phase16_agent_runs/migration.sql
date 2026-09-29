-- Phase 16 slice 5: viewable agent runs (Playwright run recorder).
-- AgentRun = persisted run lifecycle (links back to chat thread / mission);
-- AgentRunRecording = host-owned artifact paths (video webm + trace zip);
-- AgentRunEvent = structured run timeline (agui | gate | browser | note).
-- `prisma migrate deploy` against the durable PG (:5433) is deferred to
-- phase verification; this SQL is validated on a scratch DB in the slice.

CREATE TYPE "AgentRunKind" AS ENUM ('mission', 'playbook', 'browser', 'follow_up');
CREATE TYPE "AgentRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE "AgentRunEventType" AS ENUM ('agui', 'gate', 'browser', 'note');

CREATE TABLE "agent_runs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "kind" "AgentRunKind" NOT NULL,
  "status" "AgentRunStatus" NOT NULL DEFAULT 'queued',
  "started_by" TEXT NOT NULL,
  "thread_id" TEXT,
  "mission_id" TEXT,
  "agent_state" JSONB,
  "next_seq" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(3),
  CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_runs_workspace_id_status_created_at_idx"
  ON "agent_runs"("workspace_id", "status", "created_at");
CREATE INDEX "agent_runs_workspace_id_thread_id_idx"
  ON "agent_runs"("workspace_id", "thread_id");
CREATE INDEX "agent_runs_workspace_id_mission_id_idx"
  ON "agent_runs"("workspace_id", "mission_id");
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_run_recordings" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "video_path" TEXT,
  "trace_path" TEXT,
  "step_count" INTEGER NOT NULL DEFAULT 0,
  "size_bytes" BIGINT NOT NULL DEFAULT 0,
  "retention_until" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_run_recordings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_run_recordings_run_id_key" UNIQUE ("run_id")
);
CREATE INDEX "agent_run_recordings_workspace_id_created_at_idx"
  ON "agent_run_recordings"("workspace_id", "created_at");
ALTER TABLE "agent_run_recordings" ADD CONSTRAINT "agent_run_recordings_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_run_events" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" "AgentRunEventType" NOT NULL,
  "summary" TEXT NOT NULL,
  "payload" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_run_events_run_id_seq_key" UNIQUE ("run_id", "seq")
);
CREATE INDEX "agent_run_events_workspace_id_run_id_seq_idx"
  ON "agent_run_events"("workspace_id", "run_id", "seq");
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: same tenant-isolation pattern as phase 15 slice 5.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "agent_runs" FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY agent_runs_tenant_isolation ON "agent_runs" FOR ALL ' ||
          'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
          'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))';

  EXECUTE 'ALTER TABLE "agent_run_recordings" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "agent_run_recordings" FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY agent_run_recordings_tenant_isolation ON "agent_run_recordings" FOR ALL ' ||
          'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
          'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))';

  EXECUTE 'ALTER TABLE "agent_run_events" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "agent_run_events" FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY agent_run_events_tenant_isolation ON "agent_run_events" FOR ALL ' ||
          'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
          'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))';
END $$;
