-- ShapesOS Phase 18.1 (WS=find): per-user preferences (lib/preferences).
-- One row per person (Auth.js subject), global across workspaces. No
-- workspace_id and no tenant RLS, like user_security and notifications:
-- every read and write is keyed to the session's own subject
-- (app/api/preferences uses requireSelfService), and account deletion
-- removes the row (lib/gdpr/account-delete.ts PERSONAL_TABLES).
-- The enum-like text columns carry CHECK constraints so even a hand-written
-- UPDATE can't store a value the shell can't render; the JSON columns are
-- validated by lib/preferences/schema.ts.

-- CreateTable
CREATE TABLE "user_preferences" (
    "user_id" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "contrast" TEXT NOT NULL DEFAULT 'standard',
    "language" TEXT,
    "time_zone" TEXT,
    "hour_cycle" TEXT NOT NULL DEFAULT 'auto',
    "density" TEXT NOT NULL DEFAULT 'comfortable',
    "motion" TEXT NOT NULL DEFAULT 'system',
    "font_scale" INTEGER NOT NULL DEFAULT 100,
    "notifications" JSONB NOT NULL DEFAULT '{}',
    "shortcuts" JSONB NOT NULL DEFAULT '{}',
    "desktop" JSONB NOT NULL DEFAULT '{}',
    "voice" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "user_preferences"
  ADD CONSTRAINT "user_preferences_theme_check" CHECK ("theme" IN ('system', 'light', 'dark')),
  ADD CONSTRAINT "user_preferences_contrast_check" CHECK ("contrast" IN ('standard', 'high')),
  ADD CONSTRAINT "user_preferences_language_check" CHECK ("language" IS NULL OR "language" IN ('en', 'es')),
  ADD CONSTRAINT "user_preferences_time_zone_check" CHECK ("time_zone" IS NULL OR "time_zone" ~ '^[A-Za-z0-9_+/-]{1,64}$'),
  ADD CONSTRAINT "user_preferences_hour_cycle_check" CHECK ("hour_cycle" IN ('auto', 'h12', 'h23')),
  ADD CONSTRAINT "user_preferences_density_check" CHECK ("density" IN ('comfortable', 'compact')),
  ADD CONSTRAINT "user_preferences_motion_check" CHECK ("motion" IN ('system', 'reduce')),
  ADD CONSTRAINT "user_preferences_font_scale_check" CHECK ("font_scale" IN (100, 112, 125, 150)),
  ADD CONSTRAINT "user_preferences_json_check" CHECK (
    jsonb_typeof("notifications") = 'object' AND jsonb_typeof("shortcuts") = 'object'
    AND jsonb_typeof("desktop") = 'object' AND jsonb_typeof("voice") = 'object'
  );
