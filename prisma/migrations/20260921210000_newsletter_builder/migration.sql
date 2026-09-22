-- Marketr milestone 19: editable newsletter builder (react-email + Resend).
-- (Hand-written — no PostgreSQL in sandbox; review before deploy.)

-- New enums
CREATE TYPE "NewsletterDomainStatus" AS ENUM ('pending', 'verified', 'failed');
CREATE TYPE "SubscriberStatus" AS ENUM ('subscribed', 'unsubscribed', 'bounced', 'complained');
CREATE TYPE "BroadcastStatus" AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled');

-- Audit enum additions
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_template_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_template_updated';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_template_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_list_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_list_deleted';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_subscribers_imported';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_subscriber_unsubscribed';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_domain_added';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_domain_verified';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_test_sent';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_broadcast_created';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_broadcast_scheduled';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_broadcast_sent';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_broadcast_failed';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_broadcast_cancelled';
ALTER TYPE "FileChangeAction" ADD VALUE 'newsletter_resend_key_updated';

-- Workspace newsletter settings (BYO Resend key, encrypted)
CREATE TABLE "newsletter_settings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "resend_key_enc" TEXT,
    "resend_key_hint" TEXT,
    "default_from_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newsletter_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "newsletter_settings_workspace_id_key" ON "newsletter_settings"("workspace_id");

ALTER TABLE "newsletter_settings" ADD CONSTRAINT "newsletter_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sending domains
CREATE TABLE "newsletter_domains" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "resend_domain_id" TEXT,
    "status" "NewsletterDomainStatus" NOT NULL DEFAULT 'pending',
    "dns_records" JSONB NOT NULL DEFAULT '[]',
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newsletter_domains_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "newsletter_domains_workspace_id_domain_key" ON "newsletter_domains"("workspace_id", "domain");
ALTER TABLE "newsletter_domains" ADD CONSTRAINT "newsletter_domains_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Subscriber lists
CREATE TABLE "newsletter_lists" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "double_opt_in" BOOLEAN NOT NULL DEFAULT true,
    "resend_audience_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newsletter_lists_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "newsletter_lists" ADD CONSTRAINT "newsletter_lists_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Subscribers
CREATE TABLE "subscribers" (
    "id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "status" "SubscriberStatus" NOT NULL DEFAULT 'subscribed',
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscribers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subscribers_token_key" ON "subscribers"("token");
CREATE UNIQUE INDEX "subscribers_list_id_email_key" ON "subscribers"("list_id", "email");
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "newsletter_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Templates
CREATE TABLE "newsletter_templates" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tiptap" JSONB NOT NULL,
    "brand_kit_id" TEXT,
    "is_starter" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newsletter_templates_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "newsletter_templates" ADD CONSTRAINT "newsletter_templates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "newsletter_templates" ADD CONSTRAINT "newsletter_templates_brand_kit_id_fkey" FOREIGN KEY ("brand_kit_id") REFERENCES "brand_kits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Broadcasts
CREATE TABLE "newsletter_broadcasts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "template_snapshot" JSONB NOT NULL,
    "brand_kit_id" TEXT,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMP(3),
    "test_sent_at" TIMESTAMP(3),
    "test_sent_to" TEXT,
    "resend_broadcast_id" TEXT,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newsletter_broadcasts_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "newsletter_broadcasts" ADD CONSTRAINT "newsletter_broadcasts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "newsletter_broadcasts" ADD CONSTRAINT "newsletter_broadcasts_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "newsletter_lists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "newsletter_broadcasts" ADD CONSTRAINT "newsletter_broadcasts_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "newsletter_domains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
