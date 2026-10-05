-- Phase 2 (time zones): explicit IANA timezones instead of the server's local
-- zone. Workflow schedules are read in the workflow's zone; WFH standups,
-- digests and focus hours in the user's; rituals step by calendar in theirs.
-- Existing rows default to UTC (what a UTC server already did).

-- AlterTable
ALTER TABLE "workflows" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
ALTER TABLE "wfh_work_modes" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
ALTER TABLE "wfh_rituals" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';
