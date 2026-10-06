-- ShapesOS Phase 17 (A4, WS=model): Message Batches submissions (lib/llm/batch.ts).
-- One row per batch: the durable pending -> submitted -> ended -> delivered
-- state machine the `llm_batch` agent job advances (a worker restart
-- continues from it; idempotency_key is unique per workspace). FORCE RLS on
-- the app.workspace_id GUC (fail-closed), cascades from the workspace.

-- CreateTable
CREATE TABLE "llm_batch_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "workload" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "provider_batch_id" TEXT,
    "requests" JSONB NOT NULL,
    "results" JSONB,
    "context" JSONB,
    "polls" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "llm_batch_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_batch_jobs_workspace_id_status_idx" ON "llm_batch_jobs"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "llm_batch_jobs_workspace_id_idempotency_key_key" ON "llm_batch_jobs"("workspace_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "llm_batch_jobs" ADD CONSTRAINT "llm_batch_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: the repo's tenant-isolation pattern (see 20261005300000_phase4a_webhooks).
-- ============================================================
ALTER TABLE "llm_batch_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "llm_batch_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "llm_batch_jobs_tenant_isolation" ON "llm_batch_jobs" FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
