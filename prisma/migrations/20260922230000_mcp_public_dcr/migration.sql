-- Marketr Phase C (W5): public DCR (RFC 7591) + mcp_rpc audit action.
-- DCR registration no longer requires a signed-in owner: the client is claimed
-- by the approving user at consent time. Registration itself creates no secret,
-- binds no workspace, and mints no token.

-- Make McpOAuthClient.user_id nullable (unclaimed until first consent approval).
ALTER TABLE "mcp_oauth_clients" ALTER COLUMN "user_id" DROP NOT NULL;

-- Audit action for non-tool MCP RPC calls (initialize, tools/list).
ALTER TYPE "FileChangeAction" ADD VALUE 'mcp_rpc';
