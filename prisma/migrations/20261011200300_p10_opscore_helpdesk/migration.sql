-- ShapesOS Phase 10 (ops-core): helpdesk — tickets, ticket messages, SLA
-- policies. All three tables are FORCE RLS on app.workspace_id and cascade
-- from workspaces. Inbound email is matched to a workspace ONLY by the signed
-- support/reply address (lib/messaging/inbound-email.ts), then written under
-- that workspace's GUC.

-- CreateEnum
CREATE TYPE "OpsTicketStatus" AS ENUM ('new', 'open', 'pending', 'solved', 'closed');

-- CreateEnum
CREATE TYPE "OpsTicketPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "OpsTicketChannel" AS ENUM ('email', 'web', 'phone', 'chat', 'agent');

-- CreateEnum
CREATE TYPE "OpsTicketMessageDirection" AS ENUM ('inbound', 'outbound', 'note');

-- CreateTable
CREATE TABLE "ops_sla_policies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "priority" "OpsTicketPriority" NOT NULL,
    "first_response_minutes" INTEGER NOT NULL,
    "resolution_minutes" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_tickets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "OpsTicketStatus" NOT NULL DEFAULT 'new',
    "priority" "OpsTicketPriority" NOT NULL DEFAULT 'normal',
    "channel" "OpsTicketChannel" NOT NULL DEFAULT 'web',
    "requester_email" TEXT,
    "requester_name" TEXT,
    "contact_id" TEXT,
    "assignee_id" TEXT,
    "first_response_due_at" TIMESTAMP(3),
    "resolution_due_at" TIMESTAMP(3),
    "first_responded_at" TIMESTAMP(3),
    "solved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "sla_breached_at" TIMESTAMP(3),
    "sla_breach_kind" TEXT,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_ticket_messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "direction" "OpsTicketMessageDirection" NOT NULL,
    "author_user_id" TEXT,
    "from_email" TEXT,
    "to_email" TEXT,
    "body" TEXT NOT NULL,
    "provider_sid" TEXT,
    "delivery_status" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_sla_policies_workspace_id_priority_key" ON "ops_sla_policies"("workspace_id", "priority");

-- CreateIndex
CREATE INDEX "ops_tickets_workspace_id_status_priority_idx" ON "ops_tickets"("workspace_id", "status", "priority");

-- CreateIndex
CREATE INDEX "ops_tickets_workspace_id_assignee_id_status_idx" ON "ops_tickets"("workspace_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "ops_tickets_workspace_id_requester_email_idx" ON "ops_tickets"("workspace_id", "requester_email");

-- CreateIndex
CREATE UNIQUE INDEX "ops_tickets_workspace_id_number_key" ON "ops_tickets"("workspace_id", "number");

-- CreateIndex
CREATE INDEX "ops_ticket_messages_workspace_id_ticket_id_created_at_idx" ON "ops_ticket_messages"("workspace_id", "ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ops_ticket_messages_workspace_id_provider_sid_key" ON "ops_ticket_messages"("workspace_id", "provider_sid");

-- AddForeignKey
ALTER TABLE "ops_sla_policies" ADD CONSTRAINT "ops_sla_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_tickets" ADD CONSTRAINT "ops_tickets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_tickets" ADD CONSTRAINT "ops_tickets_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "ops_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_ticket_messages" ADD CONSTRAINT "ops_ticket_messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_ticket_messages" ADD CONSTRAINT "ops_ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ops_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================
-- RLS: same tenant-isolation pattern as the phase-16/17 migrations.
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_sla_policies', 'ops_tickets', 'ops_ticket_messages'] LOOP
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
