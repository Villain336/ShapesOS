-- Phase 6 (infra): shared store for the API rate limiter and the login
-- lockout, so limits hold across app replicas (lib/api/rate-limit-store.ts,
-- selected by RATE_LIMIT_STORE; default postgres when DATABASE_URL is set).
--
-- GLOBAL table — deliberately NO workspace_id and NO row-level security:
--   * keys are opaque limiter keys ("write:user:<id>", "auth:ip:<ip>",
--     "login:acct:<email>", ...) checked BEFORE any tenant is resolved (the
--     request proxy, pre-auth sign-in), so there is no workspace to scope by;
--   * rows hold counters and epoch-ms timestamps only, never tenant content;
--   * only lib/api/rate-limit-store.ts reads or writes it.
-- The runtime app role gets SELECT/INSERT/UPDATE/DELETE through the default
-- privileges in scripts/db/create-app-role.sql, like every public table.
--
-- One row per key. Fixed windows are one atomic
-- INSERT ... ON CONFLICT (key) DO UPDATE ... RETURNING (row lock serialises
-- concurrent hits, so counts are exact). expires_at drives cleanup.

-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "window_start" BIGINT NOT NULL,
    "count" INTEGER NOT NULL,
    "locked_until" BIGINT,
    "expires_at" BIGINT NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "rate_limit_buckets_expires_at_idx" ON "rate_limit_buckets"("expires_at");
