-- Day-1 fix (edge #7): atomic dispatch claim for social posts.
-- dispatchPost() claims a post by moving it scheduled/failed -> dispatching
-- via updateMany; exactly one concurrent dispatcher can win the claim, which
-- closes the double-dispatch race (manual send + cron, overlapping crons).
-- The claim is always released back to scheduled on failure. Stale
-- "dispatching" claims (dispatcher crashed mid-dispatch) are reclaimed to
-- "scheduled" by the sweep after 15 minutes — the per-channel idempotency in
-- dispatchPost makes that re-dispatch safe.
ALTER TYPE "SocialPostStatus" ADD VALUE IF NOT EXISTS 'dispatching';
