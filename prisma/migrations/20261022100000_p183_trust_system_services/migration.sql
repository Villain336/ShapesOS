-- ShapesOS Phase 18.3 (WS=trust): system services.
--
--   NotificationKind      + run_finished, invoice_paid, ticket_assigned,
--                         meeting_starting (Notifications 2.0)
--   notifications         + digested_at (each row goes out in the person's
--                         email digest at most once)
--   workspace_settings    + agent_blocked_groups (agent app permissions:
--                         tool groups agents may not use; empty = all allowed)
--   user_sessions         the per-person session registry behind the JWT
--                         (sign out other sessions, per-row revoke).
--                         Owner-only: FORCE RLS on app.user_id.
--
-- The new enum values are not used in this migration (Postgres refuses a new
-- enum value inside the transaction that added it).

ALTER TYPE "NotificationKind" ADD VALUE 'run_finished';
ALTER TYPE "NotificationKind" ADD VALUE 'invoice_paid';
ALTER TYPE "NotificationKind" ADD VALUE 'ticket_assigned';
ALTER TYPE "NotificationKind" ADD VALUE 'meeting_starting';

-- AlterTable
ALTER TABLE "workspace_settings" ADD COLUMN     "agent_blocked_groups" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "digested_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" VARCHAR(64),
    "user_agent" VARCHAR(400),
    "device_label" VARCHAR(120),
    "ip_prefix" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" VARCHAR(200),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_sessions_user_id_revoked_at_idx" ON "user_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");


-- ============================================================
-- RLS: owner-only (app.user_id). ENABLE + FORCE; fail-closed
-- without the GUC (lib/auth/sessions.ts sets it from the token's
-- own subject before every read or write).
-- ============================================================
ALTER TABLE "user_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_sessions_owner_isolation" ON "user_sessions" FOR ALL
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
