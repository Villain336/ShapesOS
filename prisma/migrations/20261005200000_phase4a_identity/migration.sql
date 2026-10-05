-- ShapesOS Phase 4a (identity): TOTP 2FA + recovery codes, passkeys
-- (WebAuthn), workspace "require 2FA" policy, SCIM 2.0 provisioning.
--
-- User-level tables (user_security, user_recovery_codes, user_passkeys,
-- auth_challenges) are keyed by the Auth.js subject and hold no workspace
-- data: no tenant RLS. SCIM tables are workspace-owned: ENABLE + FORCE ROW
-- LEVEL SECURITY keyed on the app.workspace_id GUC (sessions without the GUC
-- see zero rows). A SCIM bearer token names its workspace, so even the token
-- lookup runs inside that workspace's scope.

-- Audit actions (FileChangeAction).
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'security_2fa_enabled';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'security_2fa_disabled';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'security_recovery_codes_regenerated';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'security_recovery_code_used';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'security_passkey_added';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'security_passkey_removed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'security_policy_updated';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scim_token_created';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scim_token_revoked';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scim_user_provisioned';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scim_user_updated';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scim_user_deprovisioned';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scim_user_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'scim_group_changed';

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN "require_two_factor" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "workspace_members" ADD COLUMN "scim_deactivated_at" TIMESTAMP(3),
ADD COLUMN "scim_external_id" TEXT,
ADD COLUMN "scim_managed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "scim_profile" JSONB,
ADD COLUMN "scim_suspended_user_id" TEXT;

-- CreateTable
CREATE TABLE "user_security" (
    "user_id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "totp_secret_enc" TEXT,
    "totp_enabled_at" TIMESTAMP(3),
    "totp_last_step" BIGINT,
    "totp_pending_enc" TEXT,
    "totp_pending_at" TIMESTAMP(3),
    "webauthn_user_handle" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_security_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_passkeys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT,
    "user_name" TEXT,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "device_type" TEXT,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "aaguid" TEXT,
    "name" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_challenges" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "user_id" TEXT,
    "challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_tokens" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_groups" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "external_id" TEXT,
    "role" "WorkspaceRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_group_members" (
    "group_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scim_group_members_pkey" PRIMARY KEY ("group_id","member_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_security_webauthn_user_handle_key" ON "user_security"("webauthn_user_handle");

-- CreateIndex
CREATE UNIQUE INDEX "user_recovery_codes_code_hash_key" ON "user_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "user_recovery_codes_user_id_idx" ON "user_recovery_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_passkeys_credential_id_key" ON "user_passkeys"("credential_id");

-- CreateIndex
CREATE INDEX "user_passkeys_user_id_idx" ON "user_passkeys"("user_id");

-- CreateIndex
CREATE INDEX "auth_challenges_expires_at_idx" ON "auth_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "scim_tokens_token_hash_key" ON "scim_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "scim_tokens_workspace_id_idx" ON "scim_tokens"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "scim_groups_workspace_id_display_name_key" ON "scim_groups"("workspace_id", "display_name");

-- CreateIndex
CREATE INDEX "scim_group_members_member_id_idx" ON "scim_group_members"("member_id");

-- CreateIndex
CREATE INDEX "scim_group_members_workspace_id_idx" ON "scim_group_members"("workspace_id");

-- AddForeignKey
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "scim_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "workspace_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation: FORCE RLS on the workspace-owned SCIM tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scim_tokens', 'scim_groups', 'scim_group_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL ' ||
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) ' ||
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;
