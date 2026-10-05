-- ShapesOS Phase 4a: outbound webhooks (lib/webhooks).
-- webhook_endpoints: per-workspace URLs with an event filter and an
-- HMAC-SHA256 signing secret (secrets() envelope; the raw secret is shown
-- once). webhook_deliveries: one durable row per (event, endpoint), drained
-- by /api/cron/webhooks with exponential backoff; `dead` is the dead letter.
-- Both tables are FORCE RLS on the app.workspace_id GUC (fail-closed).

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'delivering', 'succeeded', 'dead');

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret_enc" TEXT NOT NULL,
    "secret_hint" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_success_at" TIMESTAMP(3),
    "last_failure_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "dedup_key" TEXT,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "response_status" INTEGER,
    "response_body" TEXT,
    "last_error" TEXT,
    "duration_ms" INTEGER,
    "redelivery_of" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_endpoints_workspace_id_enabled_idx" ON "webhook_endpoints"("workspace_id", "enabled");

-- CreateIndex
CREATE INDEX "webhook_deliveries_workspace_id_status_next_attempt_at_idx" ON "webhook_deliveries"("workspace_id", "status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_created_at_idx" ON "webhook_deliveries"("endpoint_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_workspace_id_created_at_idx" ON "webhook_deliveries"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_id_dedup_key_key" ON "webhook_deliveries"("endpoint_id", "dedup_key");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17 migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_endpoints', 'webhook_deliveries'] LOOP
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
