-- Day-1 security hardening: tokenized workspace invites (M5).
-- Pending invites are claimed via a single-use token link instead of bare
-- email match. Existing pending invites are backfilled with tokens so they
-- stay claimable through the new flow.

-- Backfill uses gen_random_bytes (pgcrypto).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "workspace_members"
  ADD COLUMN "invite_token" TEXT,
  ADD COLUMN "invite_expires_at" TIMESTAMPTZ;

-- Backfill: every still-pending invite (user_id IS NULL) without a token
-- gets a fresh single-use token valid for 7 days.
UPDATE "workspace_members"
SET "invite_token" = encode(gen_random_bytes(32), 'hex'),
    "invite_expires_at" = NOW() + INTERVAL '7 days'
WHERE "user_id" IS NULL AND "invite_token" IS NULL;

CREATE UNIQUE INDEX "workspace_members_invite_token_key" ON "workspace_members"("invite_token");

-- Day-1 hardening: authentication audit events (H1/M8).
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'auth_login_failed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'auth_login_succeeded';
