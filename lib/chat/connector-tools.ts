// Marketr — agent-loop connector tools (milestone 21, part C).
//
// Dynamic tool resolution for `connector.<connectorKey>.<toolName>` calls
// the agent emits. Every invocation goes through, in order:
//   1. Agent allow-list (WorkspaceSettings.agentAllowList)
//   2. Project data-source binding + active connection
//   3. Adapter resolution + known-tool check
//   4. Declared-tool gating against load_skill-loaded skills
//   5. Role gate (mutating → editor+, reads → viewer+)
//   6. Confirmation gate (mutating tools behave like kind "publish")
//   7. invoke() with the server-side decrypted credential (never in args)
//
// Denials are NEVER silent: the resultSummary explains, and every denial
// writes a FileChangeLog row (action connector_tool_denied).

import { prisma } from "@/lib/prisma";
import { roleAtLeast } from "@/lib/authz";
import { auditEvent } from "@/lib/auditlog";
import { getDecryptedCredential } from "@/lib/vault/refresh";
import { getAdapterForConnection } from "@/lib/connectors/m21";
import type {
  ConnectorAdapter,
  ConnectorToolDef,
} from "@/lib/connectors/m21/types";
import type { ToolContext } from "./tools";

export interface ConnectorToolOutcome {
  status: "executed" | "pending_confirmation" | "error" | "skipped_role";
  resultSummary: string;
}

export interface BoundDataSource {
  bindingId: string;
  connectorKey: string;
  connectionId: string;
  connectionStatus: string;
  displayName: string;
  projectConfig: Record<string, unknown> | null;
  mcpEndpoint: string | null;
  /** Connector.config (carries the MCP read-only allow-list). */
  connectorConfig: unknown;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Active project data-source bindings for the prompt section + gating. */
export async function boundDataSources(projectId: string): Promise<BoundDataSource[]> {
  const bindings = await prisma.projectDataSource.findMany({
    where: { projectId },
    include: { connection: { include: { connector: true } } },
    orderBy: { connectorKey: "asc" },
  });
  const out: BoundDataSource[] = [];
  for (const b of bindings) {
    const conn = b.connection;
    if (!conn || conn.status !== "active") continue;
    out.push({
      bindingId: b.id,
      connectorKey: b.connectorKey,
      connectionId: conn.id,
      connectionStatus: conn.status,
      displayName: conn.connector?.displayName ?? b.connectorKey,
      projectConfig:
        b.projectConfig && typeof b.projectConfig === "object"
          ? (b.projectConfig as Record<string, unknown>)
          : null,
      mcpEndpoint: conn.connector?.mcpEndpoint ?? null,
      connectorConfig: conn.connector?.config ?? null,
    });
  }
  return out;
}

async function listAdapterTools(adapter: ConnectorAdapter): Promise<ConnectorToolDef[]> {
  const maybeAsync = adapter as ConnectorAdapter & {
    listToolsAsync?: () => Promise<ConnectorToolDef[]>;
  };
  if (typeof maybeAsync.listToolsAsync === "function") {
    return maybeAsync.listToolsAsync();
  }
  return adapter.listTools();
}

/**
 * "CONNECTOR TOOLS" system-prompt section: one
 * `connector.<key>.<toolName>: <description>` line per tool of every
 * enabled project data source (active connections only).
 */
export async function connectorToolsSection(projectId: string): Promise<string> {
  const header = "## CONNECTOR TOOLS";
  const sources = await boundDataSources(projectId);
  if (sources.length === 0) {
    return `${header}\n\nNo connector data sources are bound to this project.`;
  }
  const lines: string[] = [];
  for (const s of sources) {
    let tools: ConnectorToolDef[];
    try {
      const adapter = await getAdapterForConnection({
        connectorKey: s.connectorKey,
        connector: { mcpEndpoint: s.mcpEndpoint, config: s.connectorConfig },
      });
      tools = await listAdapterTools(adapter);
    } catch (err) {
      lines.push(`# ${s.displayName} (${s.connectorKey}) — tools unavailable: ${err instanceof Error ? err.message : "unknown error"}`);
      continue;
    }
    lines.push(`# ${s.displayName} (${s.connectorKey})`);
    for (const t of tools) {
      lines.push(`connector.${s.connectorKey}.${t.name}: ${t.description}${t.mutating ? " [mutating]" : ""}`);
    }
  }
  return `${header}\n\n${lines.join("\n")}`;
}

function parseConnectorTool(toolName: string): { key: string; tool: string } | null {
  if (!toolName.startsWith("connector.")) return null;
  const rest = toolName.slice("connector.".length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null; // connectorKey may contain dashes; tool is the last segment
  return { key: rest.slice(0, dot), tool: rest.slice(dot + 1) };
}

async function deny(
  ctx: ToolContext,
  toolName: string,
  reason: string,
): Promise<ConnectorToolOutcome> {
  await auditEvent({
    projectId: ctx.projectId,
    workspaceId: ctx.workspaceId,
    actor: "ai",
    action: "connector_tool_denied",
    summary: `${toolName}: ${reason}`,
  });
  return { status: "error", resultSummary: reason };
}

/**
 * Resolve and execute `connector.<key>.<toolName>`. Returns a ChatToolCall
 * status + summary; every denial is explained and audited.
 */
export async function resolveConnectorTool(
  toolName: string,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ConnectorToolOutcome> {
  const parsed = parseConnectorTool(toolName);
  if (!parsed) {
    return {
      status: "error",
      resultSummary: `Malformed connector tool "${toolName}" — expected connector.<connectorKey>.<toolName>.`,
    };
  }
  const { key, tool } = parsed;

  // 1. Agent allow-list.
  const settings = await prisma.workspaceSettings.findUnique({
    where: { workspaceId: ctx.workspaceId },
    select: { agentAllowList: true },
  });
  const allowList = settings?.agentAllowList ?? [];
  if (
    allowList.length > 0 &&
    !allowList.includes("connector") &&
    !allowList.includes(key)
  ) {
    return deny(
      ctx,
      toolName,
      `Connector "${key}" is blocked by this workspace's agent allow-list — refusing.`,
    );
  }

  // 2. Project data-source binding with an active connection.
  const binding = await prisma.projectDataSource.findFirst({
    where: { projectId: ctx.projectId, connectorKey: key },
    include: { connection: { include: { connector: true } } },
  });
  const connection = binding?.connection;
  if (!binding || !connection || connection.status !== "active") {
    return deny(
      ctx,
      toolName,
      `Connector "${key}" is not connected or not enabled for this project.`,
    );
  }

  // 3. Adapter resolution + known-tool check.
  let adapter: ConnectorAdapter;
  try {
    adapter = await getAdapterForConnection({
      connectorKey: key,
      connector: {
        mcpEndpoint: connection.connector?.mcpEndpoint ?? null,
        config: connection.connector?.config ?? null,
      },
    });
  } catch (err) {
    return deny(ctx, toolName, `No adapter for connector "${key}": ${err instanceof Error ? err.message : "unknown error"}`);
  }
  let tools: ConnectorToolDef[];
  try {
    tools = await listAdapterTools(adapter);
  } catch (err) {
    return deny(
      ctx,
      toolName,
      `Could not list tools for connector "${key}": ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
  const toolDef = tools.find((t) => t.name === tool);
  if (!toolDef) {
    const available = tools.map((t) => `connector.${key}.${t.name}`).join(", ");
    return deny(
      ctx,
      toolName,
      `Unknown tool "${tool}" for connector "${key}". Available: ${available || "(none)"}.`,
    );
  }

  // 4. Declared-tool gating: a loaded skill must declare the tool.
  const loadedSlugs = [...(ctx.loadedSkills ?? [])];
  if (loadedSlugs.length > 0) {
    const full = `${key}.${tool}`;
    const declared = new Set<string>();
    const skillNames: string[] = [];
    for (const slug of loadedSlugs) {
      const skill = await prisma.skill.findFirst({
        where: { workspaceId: ctx.workspaceId, slug },
        select: { name: true, declaredTools: true },
      });
      if (skill) {
        skillNames.push(skill.name);
        for (const d of skill.declaredTools) declared.add(d);
      }
    }
    const allowed = [...declared].some((d) => full === d || full.endsWith(d));
    if (!allowed) {
      const name = skillNames[0] ?? loadedSlugs[0];
      return deny(
        ctx,
        toolName,
        `Skill "${name}" does not declare tool "${tool}" — refusing.`,
      );
    }
  }

  // 5. Role gate: mutating tools need editor+, reads need viewer+.
  const minRole = toolDef.mutating ? "editor" : "viewer";
  if (!roleAtLeast(ctx.role, minRole)) {
    await auditEvent({
      projectId: ctx.projectId,
      workspaceId: ctx.workspaceId,
      actor: "ai",
      action: "connector_tool_denied",
      summary: `${toolName}: role ${ctx.role} cannot run ${toolDef.mutating ? "mutating" : "read"} tool (needs ${minRole})`,
    });
    return {
      status: "skipped_role",
      resultSummary: `Tool "${toolName}" needs the ${minRole} role (you have ${ctx.role}).`,
    };
  }

  // 6. Confirmation gate: mutating tools behave like kind "publish".
  if (toolDef.mutating && !ctx.confirmed) {
    return {
      status: "pending_confirmation",
      resultSummary: `Proposed ${toolName} (mutating) — awaiting confirmation`,
    };
  }

  // 7. Execute with the server-side decrypted credential (never from args).
  let summary: string;
  try {
    const credential = await getDecryptedCredential(connection.id);
    const result = await adapter.invoke(tool, args, credential, {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      userId: ctx.userId,
      projectConfig: binding.projectConfig && typeof binding.projectConfig === "object"
        ? (binding.projectConfig as Record<string, unknown>)
        : undefined,
    });
    if (result.ok) {
      summary = `${toolName}: ${truncate(JSON.stringify(result.data ?? null), 500)}`;
    } else {
      summary = `${toolName} failed: ${result.error ?? "unknown error"}`;
    }
  } catch (err) {
    summary = `${toolName} failed: ${err instanceof Error ? err.message : "unknown error"}`;
  }
  const ok = !summary.includes(" failed: ");
  await auditEvent({
    projectId: ctx.projectId,
    workspaceId: ctx.workspaceId,
    actor: "ai",
    action: ctx.confirmed ? "ai_applied" : "ai_proposal",
    summary: `[connector] ${summary}`,
  });
  return ok
    ? { status: "executed", resultSummary: summary }
    : { status: "error", resultSummary: summary };
}
