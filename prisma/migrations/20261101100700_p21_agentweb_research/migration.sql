-- ShapesOS Phase 21A round 2 (WS=agentweb), M6: research workspace and browsing memory.
-- agentweb_research / agentweb_research_items: a research session and what is attached to it.
-- agentweb_memory_settings / agentweb_memory: a member's opt-in browsing memory (default OFF),
--   their excluded sites, and the pages remembered (deleted at retention or when forgotten).
-- agentweb_monitor_triggers: a Context.dev monitor linked to a workflow to run when the page changes.
-- All FORCE RLS on app.workspace_id.

-- CreateTable
CREATE TABLE "agentweb_research" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'open',
    "share_state" VARCHAR(10) NOT NULL DEFAULT 'private',
    "notes" TEXT NOT NULL DEFAULT '',
    "run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agentweb_research_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentweb_research_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "research_id" TEXT NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "ref_id" TEXT NOT NULL,
    "added_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agentweb_research_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentweb_memory_settings" (
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "retention_days" INTEGER NOT NULL DEFAULT 30,
    "excluded_sites" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agentweb_memory_settings_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "agentweb_memory" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "url_key" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "capture_id" TEXT,
    "research_id" TEXT,
    "run_id" TEXT,
    "seen_count" INTEGER NOT NULL DEFAULT 1,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retention_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agentweb_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentweb_monitor_triggers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "monitor_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fired_count" INTEGER NOT NULL DEFAULT 0,
    "last_fired_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agentweb_monitor_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agentweb_research_workspace_id_user_id_updated_at_idx" ON "agentweb_research"("workspace_id", "user_id", "updated_at");

-- CreateIndex
CREATE INDEX "agentweb_research_workspace_id_share_state_updated_at_idx" ON "agentweb_research"("workspace_id", "share_state", "updated_at");

-- CreateIndex
CREATE INDEX "agentweb_research_items_workspace_id_research_id_idx" ON "agentweb_research_items"("workspace_id", "research_id");

-- CreateIndex
CREATE UNIQUE INDEX "agentweb_research_items_research_id_kind_ref_id_key" ON "agentweb_research_items"("research_id", "kind", "ref_id");

-- CreateIndex
CREATE INDEX "agentweb_memory_workspace_id_user_id_last_seen_at_idx" ON "agentweb_memory"("workspace_id", "user_id", "last_seen_at");

-- CreateIndex
CREATE INDEX "agentweb_memory_retention_until_idx" ON "agentweb_memory"("retention_until");

-- CreateIndex
CREATE UNIQUE INDEX "agentweb_memory_workspace_id_user_id_url_key_key" ON "agentweb_memory"("workspace_id", "user_id", "url_key");

-- CreateIndex
CREATE INDEX "agentweb_monitor_triggers_workspace_id_monitor_id_idx" ON "agentweb_monitor_triggers"("workspace_id", "monitor_id");

-- CreateIndex
CREATE UNIQUE INDEX "agentweb_monitor_triggers_monitor_id_workflow_id_key" ON "agentweb_monitor_triggers"("monitor_id", "workflow_id");

-- AddForeignKey
ALTER TABLE "agentweb_research" ADD CONSTRAINT "agentweb_research_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentweb_research_items" ADD CONSTRAINT "agentweb_research_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentweb_research_items" ADD CONSTRAINT "agentweb_research_items_research_id_fkey" FOREIGN KEY ("research_id") REFERENCES "agentweb_research"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentweb_memory_settings" ADD CONSTRAINT "agentweb_memory_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentweb_memory" ADD CONSTRAINT "agentweb_memory_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agentweb_monitor_triggers" ADD CONSTRAINT "agentweb_monitor_triggers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ============================================================
-- RLS: same tenant-isolation pattern as the phase 4a / 18 migrations.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['agentweb_research', 'agentweb_research_items', 'agentweb_memory_settings', 'agentweb_memory', 'agentweb_monitor_triggers'] LOOP
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
