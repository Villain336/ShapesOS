-- ShapesOS Phase 18.1 (integration): one home for per-person preferences.
--
-- WS=desk stored the two preferences it writes (keyboard shortcut overrides
-- and voice on/off) in its own user_desk_state row until WS=find's
-- user_preferences merged. They move there now (lib/desktop/prefs.ts is an
-- adapter over lib/preferences); user_desk_state keeps only focus / do not
-- disturb, which is state, not a preference.
--
-- Data first, then the columns go. Both tables are per person (no
-- workspace_id, no tenant RLS), so this needs no GUCs.

-- 1. Shortcut overrides. The desk's map was written in the same stored
--    format lib/preferences validates ("mod+shift+k", dotted ids) and the
--    desk was the only UI that wrote it, so a non-empty desk map replaces
--    the stored one whole (merging two maps could create a clash, which
--    would make the whole key fall back to its default on read).
INSERT INTO "user_preferences" ("user_id", "shortcuts", "updated_at")
SELECT d."user_id", d."shortcuts", CURRENT_TIMESTAMP
FROM "user_desk_state" d
WHERE d."shortcuts" IS NOT NULL
  AND jsonb_typeof(d."shortcuts") = 'object'
  AND d."shortcuts" <> '{}'::jsonb
ON CONFLICT ("user_id") DO UPDATE
  SET "shortcuts" = EXCLUDED."shortcuts",
      "updated_at" = CURRENT_TIMESTAMP;

-- 2. Voice on/off → user_preferences.voice.enabled, merged into whatever the
--    voice object already holds (19A adds its own fields there). A person
--    with no preferences row and voice off keeps the default (no row).
INSERT INTO "user_preferences" ("user_id", "voice", "updated_at")
SELECT d."user_id", jsonb_build_object('enabled', d."voice_enabled"), CURRENT_TIMESTAMP
FROM "user_desk_state" d
WHERE d."voice_enabled"
   OR EXISTS (SELECT 1 FROM "user_preferences" p WHERE p."user_id" = d."user_id")
ON CONFLICT ("user_id") DO UPDATE
  SET "voice" = "user_preferences"."voice" || EXCLUDED."voice",
      "updated_at" = CURRENT_TIMESTAMP;

-- 3. The columns now live in user_preferences.
-- AlterTable
ALTER TABLE "user_desk_state" DROP COLUMN "shortcuts",
DROP COLUMN "voice_enabled";
