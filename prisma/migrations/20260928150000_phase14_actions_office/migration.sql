-- Marketr — Phase 14 (Actions & Office): Composio + Univer data model.
-- Hand-written (prisma migrate dev's shadow DB lacks pgcrypto on this box;
-- same approach as 20260927232000_phase13b_intelligence and
-- 20260928053000_phase13d_voice_agents). Purely additive: 4 new tables
-- (composio_connections, composio_action_approvals, composio_action_logs,
-- univer_docs), FORCE RLS on all new tables (same tenant-isolation pattern
-- as phase8/13b/13c/13d: app.workspace_id GUC).
--
-- Trust boundary (locked 2026-09-28): Composio HOSTED. Marketr stores only
-- the opaque Composio entity/user reference — never raw OAuth tokens.

-- One connected third-party app per workspace (Composio entity reference).
CREATE TABLE "composio_connections" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "app_key" TEXT NOT NULL,
  "composio_entity_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'connected',
  "scopes" JSONB NOT NULL DEFAULT '[]',
  "last_error" TEXT,
  "connected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "composio_connections_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "composio_connections" ADD CONSTRAINT "composio_connections_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "composio_connections_workspace_id_app_key_key" ON "composio_connections"("workspace_id", "app_key");
CREATE INDEX "composio_connections_workspace_id_status_idx" ON "composio_connections"("workspace_id", "status");

-- Human-in-the-loop approval for a proposed agent action.
CREATE TABLE "composio_action_approvals" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "app_key" TEXT NOT NULL,
  "tool_name" TEXT NOT NULL,
  "risk_tier" TEXT NOT NULL,
  "proposed_args" JSONB NOT NULL,
  "plain_summary" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(3),
  "decision_reason" TEXT,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "audit_trail" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "composio_action_approvals_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "composio_action_approvals" ADD CONSTRAINT "composio_action_approvals_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "composio_action_approvals_workspace_id_status_created_at_idx" ON "composio_action_approvals"("workspace_id", "status", "created_at");
CREATE INDEX "composio_action_approvals_workspace_id_tool_name_idx" ON "composio_action_approvals"("workspace_id", "tool_name");

-- Every executed (or attempted) action: audit + metering record.
CREATE TABLE "composio_action_logs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "approval_id" TEXT,
  "app_key" TEXT NOT NULL,
  "tool_name" TEXT NOT NULL,
  "risk_tier" TEXT NOT NULL,
  "args_summary" JSONB NOT NULL DEFAULT '{}',
  "result_summary" JSONB NOT NULL DEFAULT '{}',
  "latency_ms" INTEGER,
  "status" TEXT NOT NULL,
  "executed_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "composio_action_logs_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "composio_action_logs" ADD CONSTRAINT "composio_action_logs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "composio_action_logs" ADD CONSTRAINT "composio_action_logs_approval_id_fkey"
  FOREIGN KEY ("approval_id") REFERENCES "composio_action_approvals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "composio_action_logs_workspace_id_created_at_idx" ON "composio_action_logs"("workspace_id", "created_at");
CREATE INDEX "composio_action_logs_workspace_id_tool_name_created_at_idx" ON "composio_action_logs"("workspace_id", "tool_name", "created_at");

-- A Univer office document (sheet | doc | slide) owned by the host.
CREATE TABLE "univer_docs" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "source_ref" TEXT,
  "share_state" TEXT NOT NULL DEFAULT 'private',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "univer_docs_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "univer_docs" ADD CONSTRAINT "univer_docs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "univer_docs_workspace_id_kind_updated_at_idx" ON "univer_docs"("workspace_id", "kind", "updated_at");

-- ============================================================
-- RLS: same tenant-isolation pattern as phase8/13b/13c/13d.
-- ENABLE + FORCE; tenant principal is the app.workspace_id GUC.
-- Sessions without the GUC see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'composio_connections','composio_action_approvals','composio_action_logs','univer_docs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t
    );
  END LOOP;
END $$;
