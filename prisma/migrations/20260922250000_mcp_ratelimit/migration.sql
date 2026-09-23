-- Marketr Phase C gaps (G3): distributed MCP rate limiting.
--
-- Windowed per-credential counters shared across app instances. Increments
-- are atomic: a single INSERT ... ON CONFLICT DO UPDATE statement, so
-- concurrent instances serialize on the (bucket_key, window_start) row and
-- agree on the count (THREAT-MODEL-MCP.md T13). Expired windows are deleted
-- opportunistically by PostgresRateLimiter.cleanup().
CREATE TABLE "mcp_rate_limits" (
  "bucket_key" TEXT NOT NULL,
  "window_start" BIGINT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("bucket_key", "window_start")
);
CREATE INDEX "mcp_rate_limits_window_start_idx" ON "mcp_rate_limits" ("window_start");
