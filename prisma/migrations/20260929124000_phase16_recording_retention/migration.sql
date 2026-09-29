-- Marketr — Phase 16 slice 8: recording retention sweep.
-- Adds the pin flag (pinned recordings keep their video past retentionUntil)
-- and the video purge marker (set when the sweep drops a video; the trace is
-- always kept, per decision (c): 30 days, then summarize).

ALTER TABLE "agent_run_recordings" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "agent_run_recordings" ADD COLUMN "video_purged_at" TIMESTAMPTZ(3);
