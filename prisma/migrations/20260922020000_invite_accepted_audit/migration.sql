-- Day-1 fix: the member_invite_accepted audit action was used by
-- claimInviteToken() but never added to the Postgres enum (write would fail
-- at runtime). Add it idempotently.
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'member_invite_accepted';
