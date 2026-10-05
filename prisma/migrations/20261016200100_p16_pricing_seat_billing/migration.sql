-- Phase 15.3 (pricing): extra seats as a Stripe QUANTITY line.
-- billing_workspaces carries the admin-confirmed extra-seat ceiling and the
-- last quantity confirmed on Stripe (lib/billing/seats.ts, seats-server.ts).
-- Charging for a seat is always an admin's explicit confirmation: the billed
-- quantity is min(used − included, approved_extra_seats).

-- Audit actions for the admin's seat confirmations.
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'seat_charge_confirmed';
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'seat_ceiling_changed';

-- AlterTable
ALTER TABLE "billing_workspaces" ADD COLUMN     "approved_extra_seats" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "billed_extra_seats" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "seat_sync_error" TEXT,
ADD COLUMN     "seat_sync_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "seats_synced_at" TIMESTAMP(3);

ALTER TABLE "billing_workspaces" ADD CONSTRAINT "billing_workspaces_seat_counts_nonneg"
  CHECK ("approved_extra_seats" >= 0 AND "billed_extra_seats" >= 0 AND "seat_sync_version" >= 0);

-- billing_subscriptions (raw table, migration 20261003120000; not a Prisma
-- model) records the base fee's interval so the seat line uses the matching
-- monthly or annual seat Price (Stripe requires one interval per subscription).
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "billing_interval" TEXT;
ALTER TABLE "billing_subscriptions" DROP CONSTRAINT IF EXISTS "billing_subscriptions_interval_chk";
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_interval_chk"
  CHECK ("billing_interval" IS NULL OR "billing_interval" IN ('month', 'year'));
