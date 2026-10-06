-- ShapesOS Phase 18.3 integration: tie a Web Push subscription (WS=flow) to
-- the sign-in session that made it (WS=trust's user_sessions registry), so
-- revoking a session ("Sign out other sessions", per-row revoke) also stops
-- pushes to that browser. push_subscriptions keeps its owner-only FORCE RLS.

-- AlterTable
ALTER TABLE "push_subscriptions" ADD COLUMN     "session_id" VARCHAR(64);

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_session_id_idx" ON "push_subscriptions"("user_id", "session_id");
