-- Marketr — Phase 9 M6: approval event trail + escalation rules.
--
-- Closes M1 gap #2: `mission_approval_events` persists the hash-chained
-- executor event trail (per-approval chain: payload_hash, prev_hash,
-- event_hash) that lib/authority/executor.ts's MemoryApprovalStore kept
-- in memory. Plus `escalation_rules` — user-editable escalation rules for
-- the automation policy (§P9E).
--
-- Additive only — no existing table is altered. Same RLS tenant-isolation
-- pattern as M1's migration: ENABLE + FORCE + policy on app.workspace_id
-- GUC; sessions without the GUC see ZERO rows (fail-closed).

-- Append-only approval event trail (hash-chained per approval_id).
CREATE TABLE "mission_approval_events" (
  "id" TEXT NOT NULL,
  "approval_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "prev_hash" TEXT NOT NULL,
  "event_hash" TEXT NOT NULL,
  CONSTRAINT "mission_approval_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mission_approval_events_approval_id_ts_idx" ON "mission_approval_events"("approval_id", "ts");
CREATE INDEX "mission_approval_events_workspace_id_ts_idx" ON "mission_approval_events"("workspace_id", "ts");

-- User-editable escalation rules (workspace-scoped, ordered).
CREATE TABLE "escalation_rules" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "condition_json" JSONB NOT NULL,
  "action" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "escalation_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "escalation_rules_workspace_id_position_idx" ON "escalation_rules"("workspace_id", "position");

-- FKs
ALTER TABLE "mission_approval_events" ADD CONSTRAINT "mission_approval_events_approval_id_fkey"
  FOREIGN KEY ("approval_id") REFERENCES "mission_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mission_approval_events" ADD CONSTRAINT "mission_approval_events_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "escalation_rules" ADD CONSTRAINT "escalation_rules_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS (SPEC-PHASE9 §3.6 / §5): tenant isolation enforced at the database
-- level. FORCE so the table owner is also constrained; the tenant
-- principal is the app.workspace_id GUC. Sessions without the GUC set
-- see ZERO rows (fail-closed).
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['mission_approval_events', 'escalation_rules'] LOOP
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
