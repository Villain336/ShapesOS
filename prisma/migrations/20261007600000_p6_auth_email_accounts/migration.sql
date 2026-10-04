-- ShapesOS Phase 6 (auth): email + password accounts and email magic links.
--
-- User-level tables keyed by the Auth.js subject ("email:<normalized email>"),
-- no workspace data, so no tenant RLS (same stance as user_security and
-- user_passkeys, migration 20261005200000_phase4a_identity). Passwords are
-- stored only as scrypt hashes; links only as SHA-256 token hashes.

-- CreateEnum
CREATE TYPE "EmailAuthTokenPurpose" AS ENUM ('verify', 'login', 'reset');

-- Audit actions (FileChangeAction).
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'auth_account_created';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'auth_email_verified';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'auth_password_reset';

-- CreateTable
CREATE TABLE "email_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT,
    "email_verified_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id"),
    -- The address is stored normalized, and the subject is derived from it,
    -- so one mailbox can never map to two identities.
    CONSTRAINT "email_accounts_email_normalized" CHECK ("email" = lower(btrim("email")) AND "email" <> ''),
    CONSTRAINT "email_accounts_user_id_matches" CHECK ("user_id" = 'email:' || "email")
);

-- CreateTable
CREATE TABLE "email_auth_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "EmailAuthTokenPurpose" NOT NULL,
    "password_hash" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_auth_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_auth_tokens_email_normalized" CHECK ("email" = lower(btrim("email")) AND "email" <> '')
);

-- CreateIndex
CREATE UNIQUE INDEX "email_accounts_user_id_key" ON "email_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_accounts_email_key" ON "email_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "email_auth_tokens_token_hash_key" ON "email_auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_auth_tokens_email_created_at_idx" ON "email_auth_tokens"("email", "created_at");

-- CreateIndex
CREATE INDEX "email_auth_tokens_expires_at_idx" ON "email_auth_tokens"("expires_at");
