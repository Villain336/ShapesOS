-- ShapesOS Phase 18.3 (WS=flow): Web Push subscriptions and Time Machine.
--
--   push_subscriptions   one browser's Web Push subscription per person
--                        (lib/push/web.ts). No workspace: owner-only FORCE RLS
--                        on the person GUC (app.user_id) — a session without
--                        it sees zero rows; a write for someone else is
--                        rejected WITH CHECK. Deleted on 404/410 from the push
--                        service, on unsubscribe, and on account deletion.
--   workspace_snapshots  the manifest row of a workspace snapshot (the GDPR
--                        export stream, gzipped, in object storage). Tenant
--                        FORCE RLS on app.workspace_id; cascades with the
--                        workspace.
--   workspace_settings   snapshot schedule (off | daily | weekly, default off)
--                        and retention (1–60, default 7).

-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN     "snapshot_retention" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "snapshot_schedule" TEXT NOT NULL DEFAULT 'off';

ALTER TABLE "workspace_settings"
  ADD CONSTRAINT "workspace_settings_snapshot_schedule_check" CHECK ("snapshot_schedule" IN ('off', 'daily', 'weekly')),
  ADD CONSTRAINT "workspace_settings_snapshot_retention_check" CHECK ("snapshot_retention" BETWEEN 1 AND 60);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth_secret" TEXT NOT NULL,
    "user_agent" VARCHAR(300),
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(300),
    "last_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_endpoint_check" CHECK ("endpoint" ~ '^https://' AND length("endpoint") <= 2048);

-- CreateTable
CREATE TABLE "workspace_snapshots" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "trigger" VARCHAR(16) NOT NULL DEFAULT 'manual',
    "blob_path" TEXT,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "tables" JSONB NOT NULL DEFAULT '{}',
    "table_count" INTEGER NOT NULL DEFAULT 0,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(500),
    "last_restore" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "workspace_snapshots_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "workspace_snapshots"
  ADD CONSTRAINT "workspace_snapshots_status_check" CHECK ("status" IN ('pending', 'ready', 'failed')),
  ADD CONSTRAINT "workspace_snapshots_trigger_check" CHECK ("trigger" IN ('manual', 'scheduled'));

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_user_id_endpoint_key" ON "push_subscriptions"("user_id", "endpoint");

-- CreateIndex
CREATE INDEX "workspace_snapshots_workspace_id_created_at_idx" ON "workspace_snapshots"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "workspace_snapshots" ADD CONSTRAINT "workspace_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS. ENABLE + FORCE; fail-closed without the GUC.
-- ============================================================
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "push_subscriptions_owner_isolation" ON "push_subscriptions" FOR ALL
  USING ("user_id" = current_setting('app.user_id', true))
  WITH CHECK ("user_id" = current_setting('app.user_id', true));

ALTER TABLE "workspace_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_snapshots_tenant_isolation" ON "workspace_snapshots" FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
