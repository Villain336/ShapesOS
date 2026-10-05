-- ShapesOS Phase 15.2 (keys): record, per usage event, the agency pool it was
-- CHARGED to when that is not the event's own workspace (a pooled client
-- workspace). Overage invoicing and the pool's usage read
-- COALESCE(charged_to_workspace_id, workspace_id): the agency pays its
-- clients' overage, a pooled client never does, and history stays right
-- after a workspace joins or leaves a pool. Null = the workspace's own pool.

-- AlterTable
ALTER TABLE "usage_events" ADD COLUMN     "charged_to_workspace_id" TEXT;

-- CreateIndex
CREATE INDEX "usage_events_charged_to_workspace_id_occurred_at_idx" ON "usage_events"("charged_to_workspace_id", "occurred_at");
