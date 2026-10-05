-- Phase 4a integration.
-- 1. Direct workspace cascade for the two workspace_id tables that only
--    cascaded through a parent (orphan guard: every workspace_id table
--    cascades from workspaces).
--    No orphan cleanup needed: both already cascade from a parent that
--    cascades from workspaces, so no row can outlive its workspace.
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Account deletion tombstone (lib/gdpr/account-delete.ts).
ALTER TABLE "user_security" ADD COLUMN "account_deleted_at" TIMESTAMP(3);
