◇ injected env (0) from .env
Loaded Prisma config from prisma.config.ts.

-- AlterTable
ALTER TABLE "usage_events" ADD COLUMN     "llm_cache_hit" BOOLEAN,
ADD COLUMN     "llm_duration_ms" INTEGER,
ADD COLUMN     "llm_effort" TEXT,
ADD COLUMN     "llm_service_tier" TEXT,
ADD COLUMN     "llm_ttft_ms" INTEGER;

