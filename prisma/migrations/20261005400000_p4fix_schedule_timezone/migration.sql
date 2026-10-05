-- Phase 4a carried follow-up: scheduled skills read their cron in a
-- per-schedule IANA timezone (validated by the app; default UTC = the
-- previous behaviour for every existing schedule).
ALTER TABLE "scheduled_skills" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';
