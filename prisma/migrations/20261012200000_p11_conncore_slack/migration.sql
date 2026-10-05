-- ShapesOS Phase 11 (conncore): the Slack app.
--
-- slack_installations: one row per Slack team that installed the app (the
-- bot token lives in the vault as the "slack" connector connection's
-- credential, never here). slack_thread_links: a Slack thread (channel +
-- root ts) mapped to the ShapesOS chat thread that answers it.
-- slack_event_receipts: one row per Events API event_id (the primary key is
-- the dedupe — Slack retries deliveries).
--
-- All three are FORCE RLS on the app.workspace_id GUC and cascade from
-- workspaces. slack_installations adds ONE extra, SELECT-only policy: the
-- Events API receiver sets app.slack_route = 'lookup' for the single read
-- that maps team_id → workspace (the agent_pull_requests github_route
-- pattern). It cannot write through that policy.

-- CreateTable
CREATE TABLE "slack_installations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "team_name" TEXT,
    "bot_user_id" TEXT,
    "connection_id" TEXT NOT NULL,
    "installed_by" TEXT NOT NULL,
    "project_id" TEXT,
    "allowed_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_thread_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "thread_ts" TEXT NOT NULL,
    "chat_thread_id" TEXT NOT NULL,
    "last_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_thread_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_event_receipts" (
    "event_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "job_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_event_receipts_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_installations_team_id_key" ON "slack_installations"("team_id");

-- CreateIndex
CREATE INDEX "slack_installations_workspace_id_idx" ON "slack_installations"("workspace_id");

-- CreateIndex
CREATE INDEX "slack_thread_links_workspace_id_chat_thread_id_idx" ON "slack_thread_links"("workspace_id", "chat_thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "slack_thread_links_team_id_channel_id_thread_ts_key" ON "slack_thread_links"("team_id", "channel_id", "thread_ts");

-- CreateIndex
CREATE INDEX "slack_event_receipts_workspace_id_received_at_idx" ON "slack_event_receipts"("workspace_id", "received_at");

-- AddForeignKey
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_thread_links" ADD CONSTRAINT "slack_thread_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_event_receipts" ADD CONSTRAINT "slack_event_receipts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: tenant isolation on app.workspace_id (fail-closed).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['slack_installations', 'slack_thread_links', 'slack_event_receipts'] LOOP
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

-- Slack routing (read-only): which workspace owns a Slack team.
CREATE POLICY slack_installations_slack_route ON "slack_installations" FOR SELECT
  USING (current_setting('app.slack_route', true) = 'lookup');
