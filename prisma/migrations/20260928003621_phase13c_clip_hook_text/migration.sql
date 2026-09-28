-- Phase 13C: hook text on clips (opening line of the segment, for hook display).
ALTER TABLE "clips" ADD COLUMN "hook_text" TEXT;
