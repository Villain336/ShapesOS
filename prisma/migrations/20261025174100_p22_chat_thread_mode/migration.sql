-- Phase 22 (chat): the thread's conversation mode (ask / plan / auto).
ALTER TABLE "ai_chat_threads" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'ask';
