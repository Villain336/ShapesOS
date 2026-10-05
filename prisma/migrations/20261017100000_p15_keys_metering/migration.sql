-- ShapesOS Phase 15.1–15.2 (keys): key source on usage events, BYOK savings,
-- agency credit pooling.
--   usage_events.key_source     "platform" | "workspace" (BYOK, 0 credits) |
--                               "self_host" (local model); null = no key choice.
--   usage_events.waived_credits credits the event would have cost on the
--                               platform key (BYOK savings on Settings → Usage).
--   workspaces.credit_pool_owner_id  a client workspace spending an Agency
--                               workspace's single credit pool (meter() locks
--                               and charges the owner's balance + cap).
-- No new table: credit_balances / spend_caps / usage_events keep their
-- existing (non-RLS) metering access pattern; workspaces is unchanged in RLS.

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "credit_pool_owner_id" TEXT;

-- AlterTable
ALTER TABLE "usage_events" ADD COLUMN     "key_source" TEXT,
ADD COLUMN     "waived_credits" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "workspaces_credit_pool_owner_id_idx" ON "workspaces"("credit_pool_owner_id");

-- CreateIndex
CREATE INDEX "usage_events_workspace_id_key_source_idx" ON "usage_events"("workspace_id", "key_source");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_credit_pool_owner_id_fkey" FOREIGN KEY ("credit_pool_owner_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Guards (defence in depth for the service-layer checks).
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_key_source_check"
  CHECK ("key_source" IS NULL OR "key_source" IN ('platform', 'workspace', 'self_host'));
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_waived_credits_check"
  CHECK ("waived_credits" >= 0);
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_credit_pool_not_self_check"
  CHECK ("credit_pool_owner_id" IS NULL OR "credit_pool_owner_id" <> "id");
