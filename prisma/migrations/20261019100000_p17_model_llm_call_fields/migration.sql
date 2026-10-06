-- ShapesOS Phase 17 (A1, WS=model): per-call observability on the
-- llm_tokens usage events — time to first token, wall-clock, the effort
-- sent, whether the prompt cache was read, the provider's service tier.
-- Nullable: rows of other actions and rows written before Phase 17 stay null.

-- AlterTable
ALTER TABLE "usage_events" ADD COLUMN     "llm_cache_hit" BOOLEAN,
ADD COLUMN     "llm_duration_ms" INTEGER,
ADD COLUMN     "llm_effort" TEXT,
ADD COLUMN     "llm_service_tier" TEXT,
ADD COLUMN     "llm_ttft_ms" INTEGER;
