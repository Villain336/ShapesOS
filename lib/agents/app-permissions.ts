// ShapesOS — Phase 18.3 (WS=trust): agent app permissions (server half).
//
// The macOS "Allow … to access Mail?" for agents: per workspace, the tool
// groups (lib/agents/grants.ts TOOL_GROUPS — Mail = "email", Calendar,
// Files, …) agents may NOT use. Stored in WorkspaceSettings.agentBlockedGroups
// (empty = everything allowed, the behaviour before 18.3). NOT PermissionGrant
// rows: PermissionGrant is what PEOPLE may do (lib/authz.ts).
//
// Enforcement is the grant arithmetic itself: every computeGrant() caller
// passes the list (blockedGroups), so the model is never shown a blocked
// app's tools (toolCatalogForPrompt) and executeTool() refuses one anyway
// (the backstop also covers legacy calls with no task grant). A child can
// never widen its parent; Tier 3 and the approval gates are unchanged.
//
// Admin+ changes it (app/api/settings/agent-apps); every change writes an
// audit row (agent_app_access_changed). Reads are cached per process for a
// few seconds; a write clears this process's cache at once.

import { prisma } from "@/lib/prisma";
import { auditEvent } from "@/lib/auditlog";
import { BadRequestError } from "@/lib/api/errors";
import { BLOCKABLE_GROUPS, TOOL_GROUP_LABELS, blockableGroups, type ToolGroup } from "./grants";

const TTL_MS = 5_000;
const cache = new Map<string, { at: number; groups: ToolGroup[] }>();

/** Test hook / write path: forget the cached list. */
export function clearAgentAppPermissionCache(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

/** The workspace's blocked groups (valid, blockable names only). Never throws. */
export async function getAgentBlockedGroups(workspaceId: string, opts: { fresh?: boolean } = {}): Promise<ToolGroup[]> {
  if (!workspaceId) return [];
  const hit = cache.get(workspaceId);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.groups;
  try {
    const row = await prisma.workspaceSettings.findUnique({ where: { workspaceId }, select: { agentBlockedGroups: true } });
    const groups = blockableGroups(row?.agentBlockedGroups ?? []);
    cache.set(workspaceId, { at: Date.now(), groups });
    return groups;
  } catch (err) {
    // A read error keeps the last list this process saw (a block never
    // silently lifts because the database blinked); with none, nothing is
    // blocked — the same as a workspace that never set any.
    console.warn("[agent-apps] blocked groups read failed:", err instanceof Error ? err.message : err);
    return hit?.groups ?? [];
  }
}

export class AgentAppPermissionError extends BadRequestError {}

/**
 * Replace the workspace's blocked groups. The caller has already checked
 * admin+. Returns the stored list. Audited (one row per change, naming what
 * was blocked and allowed).
 */
export async function setAgentBlockedGroups(
  workspaceId: string,
  groups: readonly string[],
  actorUserId: string,
): Promise<ToolGroup[]> {
  const unknown = groups.filter((g) => !(BLOCKABLE_GROUPS as readonly string[]).includes(g));
  if (unknown.length) throw new AgentAppPermissionError(`These apps can't be blocked: ${unknown.join(", ")}`);
  const next = blockableGroups(groups);
  const before = await getAgentBlockedGroups(workspaceId, { fresh: true });
  await prisma.workspaceSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, agentAllowList: [], agentBlockedGroups: next, updatedBy: actorUserId },
    update: { agentBlockedGroups: next, updatedBy: actorUserId },
  });
  clearAgentAppPermissionCache(workspaceId);
  const blocked = next.filter((g) => !before.includes(g));
  const allowed = before.filter((g) => !next.includes(g));
  if (blocked.length || allowed.length) {
    const label = (g: ToolGroup) => TOOL_GROUP_LABELS[g];
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "agent_app_access_changed",
      actorUserId,
      summary: [
        blocked.length ? `Blocked agents from ${blocked.map(label).join(", ")}` : null,
        allowed.length ? `Allowed agents to use ${allowed.map(label).join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("; "),
    });
  }
  return next;
}
