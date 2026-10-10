// ShapesOS — Phase 21A round 2 (WS=agentweb): "when this page changes, run that workflow".
//
// A Context.dev monitor (lib/knowledge/contextdev/monitor.ts) already detects change. This links a
// monitor to workflows. When a check records a change, each enabled link starts its workflow
// through the workflow engine's own entry (startWorkflowRun), with the change as trigger data
// (the monitor's name and address, the digest and a short excerpt: third-party text, data only).
//   - A person links it (editor+); the run acts as that person, so their role limits what the
//     workflow can do, and a member who has left cannot be acted as (the link switches itself off).
//   - The workflow still has to be switched on by a person: an inactive workflow is not started,
//     and the link says why.
//   - The engine's own kill switch, 5-minute dedupe and Tier rules apply unchanged.
// A failing link never blocks the monitor's own bookkeeping.

import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { roleAtLeast } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

type Tx = Prisma.TransactionClient;

export class MonitorLinkError extends Error {
  constructor(
    readonly code: "forbidden" | "not_found" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "MonitorLinkError";
  }
}

export interface MonitorLinkView {
  id: string;
  monitorId: string;
  workflowId: string;
  workflowName: string;
  enabled: boolean;
  firedCount: number;
  lastFiredAt: string | null;
  lastError: string | null;
}

const MAX_LINKS_PER_MONITOR = 5;

export async function linkMonitor(workspaceId: string, userId: string, role: string, monitorId: string, workflowId: string): Promise<MonitorLinkView> {
  if (!roleAtLeast(role as never, "editor")) throw new MonitorLinkError("forbidden", "Linking a page monitor to a workflow needs the editor role.");
  const [monitor, workflow] = await Promise.all([
    prisma.monitor.findFirst({ where: { id: monitorId, workspaceId }, select: { id: true } }),
    prisma.workflow.findFirst({ where: { id: workflowId, project: { workspaceId } }, select: { id: true, name: true } }),
  ]);
  if (!monitor) throw new MonitorLinkError("not_found", "That page monitor was not found.");
  if (!workflow) throw new MonitorLinkError("not_found", "That workflow was not found.");
  const row = await withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await (tx as Tx).agentwebMonitorTrigger.findUnique({ where: { monitorId_workflowId: { monitorId, workflowId } } });
    if (existing) return (tx as Tx).agentwebMonitorTrigger.update({ where: { id: existing.id }, data: { enabled: true, createdBy: userId, lastError: null } });
    if ((await (tx as Tx).agentwebMonitorTrigger.count({ where: { workspaceId, monitorId } })) >= MAX_LINKS_PER_MONITOR) throw new MonitorLinkError("limit", `A page monitor can start up to ${MAX_LINKS_PER_MONITOR} workflows.`);
    return (tx as Tx).agentwebMonitorTrigger.create({ data: { id: `mt_${randomBytes(9).toString("hex")}`, workspaceId, monitorId, workflowId, createdBy: userId } });
  });
  return { id: row.id, monitorId, workflowId, workflowName: workflow.name, enabled: row.enabled, firedCount: row.firedCount, lastFiredAt: row.lastFiredAt?.toISOString() ?? null, lastError: row.lastError };
}

export async function unlinkMonitor(workspaceId: string, role: string, monitorId: string, workflowId: string): Promise<boolean> {
  if (!roleAtLeast(role as never, "editor")) throw new MonitorLinkError("forbidden", "Unlinking a page monitor needs the editor role.");
  const r = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMonitorTrigger.deleteMany({ where: { workspaceId, monitorId, workflowId } }));
  return r.count > 0;
}

export async function listMonitorLinks(workspaceId: string): Promise<MonitorLinkView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMonitorTrigger.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" }, take: 500 }));
  const wf = rows.length ? await prisma.workflow.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.workflowId))] }, project: { workspaceId } }, select: { id: true, name: true } }) : [];
  const names = new Map(wf.map((w) => [w.id, w.name]));
  return rows.map((r) => ({ id: r.id, monitorId: r.monitorId, workflowId: r.workflowId, workflowName: names.get(r.workflowId) ?? "(removed workflow)", enabled: r.enabled, firedCount: r.firedCount, lastFiredAt: r.lastFiredAt?.toISOString() ?? null, lastError: r.lastError }));
}

export interface MonitorChangeInfo {
  monitorId: string;
  name: string;
  url: string;
  changeId: string;
  digest: string;
  excerpt: string | null;
}

/** Start every enabled linked workflow for a detected change. Never throws. Returns how many started. */
export async function fireMonitorTriggers(workspaceId: string, change: MonitorChangeInfo, deps: { start?: typeof import("@/lib/workflow/engine").startWorkflowRun } = {}): Promise<number> {
  let started = 0;
  try {
    const links = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMonitorTrigger.findMany({ where: { workspaceId, monitorId: change.monitorId, enabled: true } }));
    for (const link of links) {
      let error: string | null = null;
      try {
        const member = await prisma.workspaceMember.findFirst({ where: { workspaceId, userId: link.createdBy }, select: { role: true } });
        if (!member || !roleAtLeast(member.role, "editor")) {
          await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMonitorTrigger.update({ where: { id: link.id }, data: { enabled: false, lastError: "The person who linked this is no longer an editor in this workspace, so it was switched off." } }));
          continue;
        }
        const workflow = await prisma.workflow.findFirst({ where: { id: link.workflowId, project: { workspaceId } }, select: { id: true, projectId: true } });
        if (!workflow) error = "The workflow no longer exists.";
        else {
          const start = deps.start ?? (await import("@/lib/workflow/engine")).startWorkflowRun;
          await start({
            workspaceId,
            projectId: workflow.projectId,
            workflowId: workflow.id,
            triggerKind: "manual",
            createdBy: link.createdBy,
            actorUserId: link.createdBy,
            payload: { source: "page_monitor", monitorId: change.monitorId, monitorName: change.name.slice(0, 120), url: change.url, changeId: change.changeId, digest: change.digest.slice(0, 500), excerpt: (change.excerpt ?? "").slice(0, 500) },
          });
          started += 1;
        }
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 300) : "The workflow did not start.";
      }
      await withWorkspaceScope(workspaceId, (tx) =>
        (tx as Tx).agentwebMonitorTrigger.update({ where: { id: link.id }, data: error ? { lastError: error } : { firedCount: { increment: 1 }, lastFiredAt: new Date(), lastError: null } }),
      ).catch(() => undefined);
    }
  } catch {
    /* the monitor's own bookkeeping is never blocked */
  }
  return started;
}

/** Everything the Page monitors tab and its API show: the workspace's monitors, workflows and links. */
export async function monitorsOverview(workspaceId: string) {
  const [monitors, workflows, links] = await Promise.all([
    prisma.monitor.findMany({ where: { workspaceId, status: { not: "archived" } }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true, url: true, cadence: true, status: true, lastChangeAt: true } }),
    prisma.workflow.findMany({ where: { project: { workspaceId } }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true, enabled: true, status: true } }),
    listMonitorLinks(workspaceId),
  ]);
  return { monitors: monitors.map((m) => ({ ...m, lastChangeAt: m.lastChangeAt?.toISOString() ?? null })), workflows, links };
}
