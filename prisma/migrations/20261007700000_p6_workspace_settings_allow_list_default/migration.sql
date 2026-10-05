-- Phase 6 (found by the new e2e CI job): restore the column default.
-- 20260924163036_call_tracking_booking dropped the DEFAULT on
-- workspace_settings.agent_allow_list (NOT NULL) while the schema had no
-- @default, so creating a workspace's first settings row (GET
-- /api/settings/workspace — Governance and Defaults pages — plus the
-- quiet-hours / Composio / playbook upserts) failed with a null-constraint
-- 500 for any workspace that had never saved settings.

-- AlterTable
ALTER TABLE "workspace_settings" ALTER COLUMN "agent_allow_list" SET DEFAULT ARRAY[]::TEXT[];
