-- Phase 2 workstream F (state-machine integrity).
-- Messaging: claim timestamp for queued → sending, so stale claims recover.
ALTER TABLE "outbound_message" ADD COLUMN "claimed_at" TIMESTAMP(3);

-- Legal: series anchor so recurring deadlines never drift (Jan 31 → Feb 28 → Mar 31).
ALTER TABLE "legal_deadlines" ADD COLUMN "recurrence_anchor" TIMESTAMP(3);
