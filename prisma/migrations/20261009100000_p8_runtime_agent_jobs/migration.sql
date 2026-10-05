-- ShapesOS Phase 8 (runtime): durable agent queue + resumable transcripts.
--
-- agent_jobs: background agent work (a chat turn handed off by the request,
-- a mission launch), claimed by workers with FOR UPDATE SKIP LOCKED
-- (lib/jobs/claim.ts) under a heartbeat-extended lease; an expired lease is
-- claimed again until max_attempts, then the row is `dead`.
-- agent_run_transcripts: the agent loop's saved state per AgentRun, written
-- after every step so a requeued job resumes instead of restarting.
-- agent_run_events gains the `text` type (streamed model text chunks).
--
-- Both tables are FORCE RLS on the app.workspace_id GUC (same as agent_runs).
-- agent_jobs adds ONE extra, SELECT-only policy: a worker sets
-- app.agent_worker = 'discover' to learn which workspaces have due jobs
-- (lib/agents/queue/store.ts). It cannot write through that policy — every
-- claim / update runs under the tenant GUC of the job's own workspace.

-- CreateEnum
CREATE TYPE "AgentJobStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead');

-- AlterEnum
ALTER TYPE "AgentRunEventType" ADD VALUE 'text';

-- CreateTable
CREATE TABLE "agent_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AgentJobStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMP(3),
    "lease_until" TIMESTAMP(3),
    "locked_by" TEXT,
    "run_id" TEXT,
    "last_error" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "agent_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_transcripts" (
    "run_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_run_transcripts_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE INDEX "agent_jobs_status_run_after_idx" ON "agent_jobs"("status", "run_after");

-- CreateIndex
CREATE INDEX "agent_jobs_workspace_id_status_run_after_idx" ON "agent_jobs"("workspace_id", "status", "run_after");

-- CreateIndex
CREATE INDEX "agent_jobs_workspace_id_run_id_idx" ON "agent_jobs"("workspace_id", "run_id");

-- CreateIndex
CREATE INDEX "agent_run_transcripts_workspace_id_idx" ON "agent_run_transcripts"("workspace_id");

-- AddForeignKey
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_transcripts" ADD CONSTRAINT "agent_run_transcripts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_transcripts" ADD CONSTRAINT "agent_run_transcripts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: tenant isolation on app.workspace_id (fail-closed), like agent_runs.
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_jobs', 'agent_run_transcripts'] LOOP
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

-- Worker discovery (read-only): which workspaces have claimable jobs.
CREATE POLICY agent_jobs_worker_discovery ON "agent_jobs" FOR SELECT
  USING (current_setting('app.agent_worker', true) = 'discover');
