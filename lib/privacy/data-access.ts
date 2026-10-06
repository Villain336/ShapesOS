// ShapesOS — Phase 18.3 (WS=trust): the data access log — which agent read
// which app's data, and when.
//
// DERIVED, never written: no new table and no new write path. Two existing
// trails already record every agent read:
//   1. AgentRunEvent tool steps — executeTool() writes a `tool_result` event
//      for every call it runs (payload { kind, tool, status }). A step counts
//      as a READ when it executed and the tool only reads: a built-in tool of
//      kind "safe", or a connector tool whose name reads (list/get/search…).
//      The tool maps to its tool group (lib/chat/tools.ts toolGroup, or
//      connectorGroup for connector.<key>.<tool>) — the "app".
//   2. OpsAuditEvent reads (action list / get) by an agent actor — the ops
//      layer logs its reads itself (app "Operations").
//
// Per person ("what agents read on my behalf"): runs the person started.
// Admins: the whole workspace. FORCE-RLS tables are read inside
// withWorkspaceScope; every query carries the workspace id.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { connectorGroup, isToolGroup, type ToolGroup } from "@/lib/agents/grants";
import { classifyActor } from "@/lib/audit-timeline/normalize";

export interface DataAccessRow {
  key: string;
  at: string;
  /** The agent that read ("lead", "researcher", "agent:inbox" …). */
  agent: string;
  group: ToolGroup;
  /** Tool or entity that was read ("connector.gmail.list_messages", "invoices"). */
  what: string;
  /** Who the run was for (user id), when known. */
  forUserId: string | null;
  runId: string | null;
  source: "agent_run" | "ops_read";
}

const READ_VERB = /(^|[._])(list|get|read|search|fetch|query|find|lookup|describe|show|view|export|download|recall|summari[sz]e)([._]|$)/i;
const WRITE_VERB = /(^|[._])(send|create|update|delete|post|publish|write|reply|schedule|push|apply|cancel|archive|remove|set|add|move|approve|reject|pay|transfer|refund|buy|sync)([._]|$)/i;

/** Is a connector tool name a read? PURE (verbs; unknown counts as not a read). */
export function isReadToolName(tool: string): boolean {
  return READ_VERB.test(tool) && !WRITE_VERB.test(tool);
}

export interface ToolInfo {
  kind: string;
  group: ToolGroup;
}

/**
 * The app a tool step read, or null when the step wasn't a read. PURE given
 * `lookup` (the tool registry: getTool + toolGroup).
 */
export function classifyToolRead(
  payload: unknown,
  lookup: (name: string) => ToolInfo | null,
): { tool: string; group: ToolGroup } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.kind !== "tool_result" || p.status !== "executed" || typeof p.tool !== "string") return null;
  const tool = p.tool;
  const m = /^connector\.([^.]+)\.(.+)$/.exec(tool);
  if (m) return isReadToolName(m[2]!) ? { tool, group: connectorGroup(m[1]!) } : null;
  const info = lookup(tool);
  if (info) return info.kind === "safe" ? { tool, group: info.group } : null;
  return null;
}

/** Ops reads by an agent: list / get by an agent actor. PURE. */
export function classifyOpsRead(r: { action: string; actor: string }): boolean {
  return (r.action === "list" || r.action === "get") && classifyActor(r.actor).kind === "agent";
}

export interface DataAccessQuery {
  workspaceId: string;
  /** Only runs this person started ("what agents read for you"). */
  forUserId?: string | null;
  group?: ToolGroup | null;
  before?: Date | null;
  limit?: number;
}

async function defaultLookup(): Promise<(name: string) => ToolInfo | null> {
  const { getTool, toolGroup } = await import("@/lib/chat/tools");
  return (name) => {
    const t = getTool(name);
    return t ? { kind: t.kind, group: toolGroup(name) } : null;
  };
}

/** One page of the log, newest first. */
export async function loadDataAccess(
  q: DataAccessQuery,
  deps: { lookup?: (name: string) => ToolInfo | null } = {},
): Promise<DataAccessRow[]> {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const lookup = deps.lookup ?? (await defaultLookup());
  const before = q.before ?? null;
  const rows: DataAccessRow[] = [];
  const scanned = await withWorkspaceScope(q.workspaceId, async (tx) => {
    const events = await tx.agentRunEvent.findMany({
      where: {
        workspaceId: q.workspaceId,
        payload: { path: ["kind"], equals: "tool_result" },
        ...(before ? { createdAt: { lt: before } } : {}),
        ...(q.forUserId ? { run: { startedBy: q.forUserId } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit * 4,
      select: { id: true, createdAt: true, runId: true, payload: true, run: { select: { agentKey: true, startedBy: true } } },
    });
    const ops = q.forUserId
      ? [] // ops reads carry no run; they only show workspace-wide
      : await tx.opsAuditEvent.findMany({
          where: { workspaceId: q.workspaceId, action: { in: ["list", "get"] }, ...(before ? { createdAt: { lt: before } } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit * 2,
          select: { id: true, createdAt: true, entity: true, entityId: true, action: true, actor: true },
        });
    return { events, ops };
  });
  for (const e of scanned.events) {
    const read = classifyToolRead(e.payload, lookup);
    if (!read) continue;
    rows.push({
      key: `agent_run_event:${e.id}`,
      at: e.createdAt.toISOString(),
      agent: e.run?.agentKey ?? "lead",
      group: read.group,
      what: read.tool,
      forUserId: e.run?.startedBy && classifyActor(e.run.startedBy).kind === "person" ? e.run.startedBy : null,
      runId: e.runId,
      source: "agent_run",
    });
  }
  for (const o of scanned.ops) {
    if (!classifyOpsRead(o)) continue;
    const actor = classifyActor(o.actor);
    rows.push({
      key: `ops_audit_event:${o.id}`,
      at: o.createdAt.toISOString(),
      agent: actor.id ?? "agent",
      group: "ops",
      what: o.entityId ? `${o.entity} ${o.entityId}` : o.entity,
      forUserId: null,
      runId: null,
      source: "ops_read",
    });
  }
  const filtered = q.group && isToolGroup(q.group) ? rows.filter((r) => r.group === q.group) : rows;
  return filtered.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1)).slice(0, limit);
}
