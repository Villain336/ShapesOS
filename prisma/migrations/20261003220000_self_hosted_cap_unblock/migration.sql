-- Self-hosted workspaces bring their own provider keys: metering records usage
-- but must never block (lib/metering/credits.ts). Cap rows were created with
-- block_at_cap = true and a 0-credit pool, so every metered action (now incl.
-- messaging) was refused. Unblock rows still at that untouched default.
UPDATE "spend_caps" AS c
   SET "block_at_cap" = false
  FROM "workspaces" AS w
 WHERE w."id" = c."workspace_id"
   AND w."plan" = 'self_hosted'
   AND c."block_at_cap" = true
   AND c."cap_credits" = 0;
