// Marketr — MCP audit writer (Phase C, W5).
//
// Every MCP call — executed or denied — writes a FileChangeLog row with
// filePath "mcp:<event>" (the 'mcp' source) and tenant tags derived
// server-side from the auth context (T10). Summaries never contain key
// material (T3). Failures are swallowed like lib/auditlog.ts: audit must
// never break the tool.

import { prisma } from "@/lib/prisma";
import type { FileChangeAction } from "@prisma/client";
import type { McpAuthContext } from "./auth";

export interface McpAuditEvent {
  projectId: string | null;
  workspaceId: string;
  action: FileChangeAction;
  /** Tool name for tool calls; human label otherwise. */
  tool?: string;
  ctx: McpAuthContext;
  /** Short outcome line, e.g. "executed, charged 1 credit" / "denied: scope". */
  outcome: string;
  charged?: number;
}

function credentialTag(ctx: McpAuthContext): string {
  return ctx.credential.kind === "api_key"
    ? `key:${ctx.credential.keyId} (${ctx.credential.keyPrefix})`
    : `oauth:${ctx.credential.clientId}`;
}

export async function mcpAudit(event: McpAuditEvent): Promise<void> {
  const summary =
    `[mcp] ${event.tool ?? event.action} ${event.outcome} ` +
    `workspace=${event.workspaceId} ${credentialTag(event.ctx)}` +
    (event.charged != null ? ` charged=${event.charged}` : "");
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: event.projectId,
        workspaceId: event.workspaceId,
        filePath: `mcp:${event.action}`,
        actor: "ai",
        action: event.action,
        summary: summary.slice(0, 500),
        approvedBy: null,
      },
    })
    .catch(() => {});
}
