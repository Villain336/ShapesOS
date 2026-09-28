-- Phase 14 slice 10: platform-wide Composio hosted free-tier counter.
-- Deliberately no RLS: aggregate counts only, must be readable without a
-- workspace scope (composio_action_logs is FORCE RLS).
CREATE TABLE "composio_platform_usage" (
  "period_key" TEXT NOT NULL,
  "calls" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "composio_platform_usage_pkey" PRIMARY KEY ("period_key")
);
