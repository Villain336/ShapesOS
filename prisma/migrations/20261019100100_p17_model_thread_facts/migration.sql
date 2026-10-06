-- ShapesOS Phase 17 (A3, WS=model): a chat thread's "facts so far" summary
-- of earlier turns' read-tool results (lib/chat/facts.ts), carried into the
-- next turn's context block as a labelled summary.

-- AlterTable
ALTER TABLE "ai_chat_threads" ADD COLUMN     "facts_summary" TEXT,
ADD COLUMN     "facts_summary_at" TIMESTAMP(3);
