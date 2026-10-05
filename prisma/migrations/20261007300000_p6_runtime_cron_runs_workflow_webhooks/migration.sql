-- Phase 6 (runtime): in-app cron runner history + signed inbound URL for the
-- workflow canvas "webhook" trigger.
--
-- cron_runs is host-wide (no workspace_id, so no RLS): one row per job run,
-- written by the replica that claimed it under the per-tick advisory lock
-- (lib/cron/store.ts). workflow_webhooks / workflow_webhook_receipts hang off
-- workflows (project-scoped, like workflow_runs) and cascade with them.

-- CreateEnum
CREATE TYPE "CronRunStatus" AS ENUM ('running', 'ok', 'failed', 'timeout');

-- CreateTable
CREATE TABLE "workflow_webhooks" (
    "workflow_id" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "created_by" TEXT,
    "last_received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_webhooks_pkey" PRIMARY KEY ("workflow_id")
);

-- CreateTable
CREATE TABLE "workflow_webhook_receipts" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "run_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_webhook_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_runs" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" "CronRunStatus" NOT NULL DEFAULT 'running',
    "http_status" INTEGER,
    "duration_ms" INTEGER,
    "error" TEXT,

    CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_webhook_receipts_workflow_id_received_at_idx" ON "workflow_webhook_receipts"("workflow_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_webhook_receipts_workflow_id_signature_key" ON "workflow_webhook_receipts"("workflow_id", "signature");

-- CreateIndex
CREATE INDEX "cron_runs_job_started_at_idx" ON "cron_runs"("job", "started_at");

-- CreateIndex
CREATE INDEX "cron_runs_started_at_idx" ON "cron_runs"("started_at");

-- AddForeignKey
ALTER TABLE "workflow_webhooks" ADD CONSTRAINT "workflow_webhooks_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_webhook_receipts" ADD CONSTRAINT "workflow_webhook_receipts_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The v1 webhook trigger stored a free-text "Shared secret" in plain node
-- config that nothing ever checked. The real secret now lives encrypted in
-- workflow_webhooks; drop the plaintext copies.
UPDATE "workflow_nodes"
   SET "config" = "config" - 'secret'
 WHERE "kind" = 'trigger' AND "type" = 'webhook' AND "config" ? 'secret';
