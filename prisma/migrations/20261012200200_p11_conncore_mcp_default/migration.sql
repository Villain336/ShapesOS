-- ShapesOS Phase 11 (conncore): the MCP server is ON by default for paid
-- plans (Pro, Agency — the plans with api_access), OFF otherwise.
--
-- workspaces.mcp_enabled becomes nullable: NULL = the plan default
-- (lib/mcp/enabled.ts), TRUE = an admin turned it on, FALSE = the explicit
-- workspace off switch (always wins).
--
-- Existing rows: before this phase every workspace defaulted to FALSE, so a
-- FALSE is either "never touched" or "an admin turned it off". Rows whose
-- audit log (file_change_log, written by PUT /api/mcp/settings) records the
-- server being disabled keep their explicit FALSE; every other FALSE becomes
-- NULL (the plan default). TRUE rows are unchanged.

-- AlterTable
ALTER TABLE "workspaces" ALTER COLUMN "mcp_enabled" DROP NOT NULL,
ALTER COLUMN "mcp_enabled" DROP DEFAULT;

UPDATE "workspaces" w
SET "mcp_enabled" = NULL
WHERE w."mcp_enabled" = false
  AND NOT EXISTS (
    SELECT 1 FROM "file_change_log" f
    WHERE f."workspace_id" = w."id"
      AND f."summary" LIKE '[mcp] mcp server disabled%'
  );
