-- Marketr — Phase 9 M1: GrowthOS data + safety core (SPEC-PHASE9.md §3, §5, §6).
--
-- Seven new workspace-scoped tables + the workspace.frozenAt column for the
-- workspace-freeze kill switch. Additive only — no existing table is altered
-- except workspaces (one nullable column).
--
-- RLS: ENABLE + FORCE + tenant-isolation policy on every new table, same
-- pattern as the Phase 8 migrations (app.workspace_id GUC; sessions without
-- the GUC see ZERO rows — fail-closed). lib/orchestrator sets the GUC per
-- transaction (same contract as lib/substrate/graph/rls.ts).
--
-- Append-only tables (mission_events, command_audit) and immutable tables
-- (playbook_versions): enforced in app code — no UPDATE/DELETE service
-- methods exist for them. The hash chains make tampering detectable.

-- Enums (match Prisma native enum names)
CREATE TYPE "MissionStatus" AS ENUM ('planned', 'active', 'paused', 'complete', 'archived');
CREATE TYPE "MissionApprovalStatus" AS ENUM ('pending', 'approved', 'denied', 'expired', 'revoked', 'executed');
CREATE TYPE "PlaybookSource" AS ENUM ('learned', 'community', 'seed');
CREATE TYPE "PlaybookVersionStatus" AS ENUM ('draft', 'eval', 'review', 'canary', 'production', 'deprecated');
CREATE TYPE "AutomationBehavior" AS ENUM ('auto', 'ask', 'never');
CREATE TYPE "CommandKind" AS ENUM ('template', 'ask', 'go', 'do');

-- Workspace-freeze kill switch (SPEC-PHASE9 §3.5). Null = not frozen.
ALTER TABLE "workspaces" ADD COLUMN "frozen_at" TIMESTAMPTZ(6);

-- Durable, goal-shaped work (SPEC §P9C).
CREATE TABLE "missions" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "template" TEXT NOT NULL,
  "goal" JSONB NOT NULL,
  "status" "MissionStatus" NOT NULL DEFAULT 'planned',
  "plan_snapshot" JSONB NOT NULL,
  "checkpoints" JSONB NOT NULL,
  "budget_caps" JSONB NOT NULL,
  "termination" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "missions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "missions_workspace_id_status_idx" ON "missions"("workspace_id", "status");

-- Append-only mission timeline (step, actor, tool, args, observation, cost).
CREATE TABLE "mission_events" (
  "id" TEXT NOT NULL,
  "mission_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor" TEXT NOT NULL,
  "step" TEXT,
  "tool" TEXT,
  "args" JSONB NOT NULL DEFAULT '{}',
  "observation" JSONB NOT NULL DEFAULT '{}',
  "cost_cents" INTEGER NOT NULL DEFAULT 0,
  "event_hash" TEXT NOT NULL,
  "prev_hash" TEXT NOT NULL,
  CONSTRAINT "mission_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mission_events_mission_id_ts_idx" ON "mission_events"("mission_id", "ts");
CREATE INDEX "mission_events_workspace_id_ts_idx" ON "mission_events"("workspace_id", "ts");

-- Approval requests extending the Phase 5/6 approval object pattern:
-- canonicalized binding JSON + SHA-256 binding hash; the approval executor
-- re-verifies the exact payload at execution time (TOCTOU kill).
CREATE TABLE "mission_approvals" (
  "id" TEXT NOT NULL,
  "mission_id" TEXT,
  "workspace_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "tier" INTEGER NOT NULL,
  "binding_json" JSONB NOT NULL,
  "binding_hash" TEXT NOT NULL,
  "status" "MissionApprovalStatus" NOT NULL DEFAULT 'pending',
  "approvers" TEXT[] NOT NULL DEFAULT '{}',
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mission_approvals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mission_approvals_workspace_id_status_idx" ON "mission_approvals"("workspace_id", "status");
CREATE INDEX "mission_approvals_mission_id_status_idx" ON "mission_approvals"("mission_id", "status");

-- Versioned procedures (SPEC §P9D): agent learning + community (opt-in).
CREATE TABLE "playbooks" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "source" "PlaybookSource" NOT NULL,
  "description" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "playbooks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "playbooks_workspace_id_source_idx" ON "playbooks"("workspace_id", "source");

-- Immutable versions: new content = new row; rollback = label pointer flip.
CREATE TABLE "playbook_versions" (
  "id" TEXT NOT NULL,
  "playbook_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "content" JSONB NOT NULL,
  "content_hash" TEXT NOT NULL,
  "status" "PlaybookVersionStatus" NOT NULL DEFAULT 'draft',
  "labels" TEXT[] NOT NULL DEFAULT '{}',
  "eval_results" JSONB,
  "outcome_attribution" JSONB,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "playbook_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "playbook_versions_playbook_id_version_key" UNIQUE ("playbook_id", "version")
);
CREATE INDEX "playbook_versions_workspace_id_status_idx" ON "playbook_versions"("workspace_id", "status");

-- Per-action automation behavior: auto | ask | never (Tico's decision).
CREATE TABLE "automation_settings" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "behavior" "AutomationBehavior" NOT NULL,
  "threshold_cents" INTEGER,
  "updated_by" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automation_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "automation_settings_workspace_id_action_key" UNIQUE ("workspace_id", "action")
);

-- Append-only command-bar audit (SPEC §P9B). prompt_full ONLY for kind=ask.
CREATE TABLE "command_audit" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "kind" "CommandKind" NOT NULL,
  "template_id" TEXT,
  "prompt_hash" TEXT,
  "prompt_full" TEXT,
  "result_summary" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "command_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "command_audit_workspace_id_created_at_idx" ON "command_audit"("workspace_id", "created_at");

-- Foreign keys
ALTER TABLE "missions" ADD CONSTRAINT "missions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "playbook_versions" ADD CONSTRAINT "playbook_versions_playbook_id_fkey"
  FOREIGN KEY ("playbook_id") REFERENCES "playbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "playbook_versions" ADD CONSTRAINT "playbook_versions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "command_audit" ADD CONSTRAINT "command_audit_workspace_id_fkey"
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
  FOREACH t IN ARRAY ARRAY[
    'missions','mission_events','mission_approvals',
    'playbooks','playbook_versions','automation_settings','command_audit'
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
