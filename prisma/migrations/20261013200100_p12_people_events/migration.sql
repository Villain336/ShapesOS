-- ShapesOS Phase 12 (people): events — sessions, ticket types,
-- registrations and attendees (lib/ops/events).
--   * Capacity: reserved/sold counters move only through row-locked
--     conditional updates (lib/ops/events/capacity.ts); these CHECKs are the
--     database backstop, so concurrent registrations can never oversell an
--     event, a session or a ticket type.
--   * Paid registrations stay pending until the tenant's signed Stripe
--     webhook confirms them; a check-in needs a confirmed attendee.
--   * /events/<slug> resolves published events through ONE SELECT-only
--     routing policy (app.event_route = 'lookup'); everything else runs under
--     the tenant GUC.
-- Every table is FORCE RLS and cascades from workspaces.

-- CreateEnum
CREATE TYPE "OpsEventStatus" AS ENUM ('draft', 'published', 'cancelled');

-- CreateEnum
CREATE TYPE "OpsEventRegistrationStatus" AS ENUM ('pending', 'confirmed', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "ops_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "venue" TEXT,
    "webinar_url" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER,
    "reserved_count" INTEGER NOT NULL DEFAULT 0,
    "status" "OpsEventStatus" NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "reminder_sequence_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "ops_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_event_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "venue" TEXT,
    "webinar_url" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER,
    "reserved_count" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "ops_event_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_event_ticket_types" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "session_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER,
    "sold_count" INTEGER NOT NULL DEFAULT 0,
    "sales_start_at" TIMESTAMP(3),
    "sales_end_at" TIMESTAMP(3),
    "max_per_order" INTEGER NOT NULL DEFAULT 10,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "ops_event_ticket_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_event_registrations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "ticket_type_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "OpsEventRegistrationStatus" NOT NULL DEFAULT 'pending',
    "source" TEXT NOT NULL DEFAULT 'public',
    "stripe_session_id" TEXT,
    "payment_ref" TEXT,
    "paid_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "reminders_enrolled_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "ops_event_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_event_attendees" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "registration_id" TEXT NOT NULL,
    "ticket_type_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "ticket_code" TEXT NOT NULL,
    "status" "OpsEventRegistrationStatus" NOT NULL DEFAULT 'pending',
    "checked_in_at" TIMESTAMP(3),
    "checked_in_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

CONSTRAINT "ops_event_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_events_slug_key" ON "ops_events"("slug");

-- CreateIndex
CREATE INDEX "ops_events_workspace_id_starts_at_idx" ON "ops_events"("workspace_id", "starts_at");

-- CreateIndex
CREATE INDEX "ops_events_workspace_id_status_idx" ON "ops_events"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "ops_event_sessions_workspace_id_event_id_starts_at_idx" ON "ops_event_sessions"("workspace_id", "event_id", "starts_at");

-- CreateIndex
CREATE INDEX "ops_event_ticket_types_workspace_id_event_id_idx" ON "ops_event_ticket_types"("workspace_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "ops_event_registrations_stripe_session_id_key" ON "ops_event_registrations"("stripe_session_id");

-- CreateIndex
CREATE INDEX "ops_event_registrations_workspace_id_event_id_status_idx" ON "ops_event_registrations"("workspace_id", "event_id", "status");

-- CreateIndex
CREATE INDEX "ops_event_registrations_workspace_id_status_expires_at_idx" ON "ops_event_registrations"("workspace_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ops_event_attendees_ticket_code_key" ON "ops_event_attendees"("ticket_code");

-- CreateIndex
CREATE INDEX "ops_event_attendees_workspace_id_event_id_status_idx" ON "ops_event_attendees"("workspace_id", "event_id", "status");

-- CreateIndex
CREATE INDEX "ops_event_attendees_workspace_id_registration_id_idx" ON "ops_event_attendees"("workspace_id", "registration_id");

-- AddForeignKey
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_reminder_sequence_id_fkey" FOREIGN KEY ("reminder_sequence_id") REFERENCES "nurture_sequence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_sessions" ADD CONSTRAINT "ops_event_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_sessions" ADD CONSTRAINT "ops_event_sessions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "ops_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_ticket_types" ADD CONSTRAINT "ops_event_ticket_types_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_ticket_types" ADD CONSTRAINT "ops_event_ticket_types_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "ops_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_ticket_types" ADD CONSTRAINT "ops_event_ticket_types_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ops_event_sessions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_registrations" ADD CONSTRAINT "ops_event_registrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_registrations" ADD CONSTRAINT "ops_event_registrations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "ops_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_registrations" ADD CONSTRAINT "ops_event_registrations_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ops_event_ticket_types"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_registrations" ADD CONSTRAINT "ops_event_registrations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "ops_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_attendees" ADD CONSTRAINT "ops_event_attendees_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_attendees" ADD CONSTRAINT "ops_event_attendees_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "ops_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_attendees" ADD CONSTRAINT "ops_event_attendees_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "ops_event_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_attendees" ADD CONSTRAINT "ops_event_attendees_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ops_event_ticket_types"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops_event_attendees" ADD CONSTRAINT "ops_event_attendees_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "ops_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Identity, money and capacity guards.
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_slug_chk"
  CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$');
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_time_chk" CHECK ("ends_at" > "starts_at");
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "ops_events" ADD CONSTRAINT "ops_events_capacity_chk"
  CHECK ("reserved_count" >= 0 AND ("capacity" IS NULL OR ("capacity" >= 0 AND "reserved_count" <= "capacity")));
ALTER TABLE "ops_event_sessions" ADD CONSTRAINT "ops_event_sessions_time_chk" CHECK ("ends_at" > "starts_at");
ALTER TABLE "ops_event_sessions" ADD CONSTRAINT "ops_event_sessions_capacity_chk"
  CHECK ("reserved_count" >= 0 AND ("capacity" IS NULL OR ("capacity" >= 0 AND "reserved_count" <= "capacity")));
ALTER TABLE "ops_event_ticket_types" ADD CONSTRAINT "ops_event_ticket_types_chk" CHECK (
  "price_cents" >= 0 AND "max_per_order" BETWEEN 1 AND 100
  AND "sold_count" >= 0 AND ("quantity" IS NULL OR ("quantity" >= 0 AND "sold_count" <= "quantity"))
  AND ("sales_start_at" IS NULL OR "sales_end_at" IS NULL OR "sales_end_at" > "sales_start_at")
);
ALTER TABLE "ops_event_registrations" ADD CONSTRAINT "ops_event_registrations_money_chk" CHECK (
  "quantity" BETWEEN 1 AND 100 AND "unit_price_cents" >= 0
  AND "amount_cents" = "unit_price_cents" * "quantity"
  AND ("status" <> 'confirmed' OR "confirmed_at" IS NOT NULL)
  AND ("status" <> 'confirmed' OR "amount_cents" = 0 OR "paid_at" IS NOT NULL)
);
ALTER TABLE "ops_event_attendees" ADD CONSTRAINT "ops_event_attendees_checkin_chk"
  CHECK ("checked_in_at" IS NULL OR "status" = 'confirmed');

-- Row-level security: fail-closed tenant isolation.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_events', 'ops_event_sessions', 'ops_event_ticket_types', 'ops_event_registrations', 'ops_event_attendees'] LOOP
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

-- Public event pages (read-only, published events only): which workspace
-- owns /events/<slug>.
CREATE POLICY ops_events_public_route ON "ops_events" FOR SELECT
  USING (current_setting('app.event_route', true) = 'lookup' AND "status" = 'published');
