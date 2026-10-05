-- ShapesOS Phase 4b (4b-INBOX-MOBILE): CRM conversation inbox read state +
-- mobile push devices. Both are workspace-owned: FORCE RLS keyed on the
-- app.workspace_id GUC (fail-closed without it).

-- CreateTable
CREATE TABLE "conversation_reads" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "last_read_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_devices" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expo_token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "device_name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "muted_kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_sent_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_reads_lead_id_idx" ON "conversation_reads"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_reads_workspace_id_user_id_lead_id_key" ON "conversation_reads"("workspace_id", "user_id", "lead_id");

-- CreateIndex
CREATE INDEX "push_devices_workspace_id_user_id_idx" ON "push_devices"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_workspace_id_expo_token_key" ON "push_devices"("workspace_id", "expo_token");

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-4a migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_reads', 'push_devices'] LOOP
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
