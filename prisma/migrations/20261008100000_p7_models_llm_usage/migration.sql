-- Phase 7 (models): LLM token usage on the existing metering ledger, and a
-- `usage` event type on agent run timelines (tokens + estimated cost per
-- model call). No new tables: usage_events keeps its append-only trigger and
-- its existing grants; agent_run_events keeps its FORCE RLS policies.

-- AlterEnum
ALTER TYPE "AgentRunEventType" ADD VALUE IF NOT EXISTS 'usage';

-- AlterTable
ALTER TABLE "usage_events" ADD COLUMN     "llm_cache_read_tokens" INTEGER,
ADD COLUMN     "llm_cache_write_tokens" INTEGER,
ADD COLUMN     "llm_cost_micro_usd" BIGINT,
ADD COLUMN     "llm_input_tokens" INTEGER,
ADD COLUMN     "llm_model" TEXT,
ADD COLUMN     "llm_output_tokens" INTEGER,
ADD COLUMN     "llm_provider" TEXT,
ADD COLUMN     "llm_workload" TEXT;
