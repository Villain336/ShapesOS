// ShapesOS — Phase 18.3 (WS=trust): one audit timeline, the read adapters.
//
// One adapter per existing audit table. Each reads ONLY the viewer's
// workspace (every query carries workspaceId; FORCE-RLS tables run inside
// withWorkspaceScope), newest first, at or before the cursor time, and maps
// rows through its normaliser (./normalize.ts). Nothing is written and no
// data is copied: this is a read-side view, not a 16th audit table.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  fromAgentRunEvent,
  fromAuthorityAuditEvent,
  fromCommandAudit,
  fromComposioActionLog,
  fromEsignAuditEvent,
  fromFileChangeLog,
  fromFlywheelAuditEvent,
  fromMediaAuditEvent,
  fromMissionEvent,
  fromOpsAuditEvent,
  fromWorkspaceLifecycleEvent,
  type ActorKind,
  type TimelineEntry,
  type TimelineSource,
} from "./normalize";

type Tx = Prisma.TransactionClient;

export interface AdapterQuery {
  workspaceId: string;
  /** Rows at or before this time (the cursor's), newest first. */
  before: Date | null;
  from: Date | null;
  take: number;
}

export interface TimelineAdapter {
  source: TimelineSource;
  /** When the source only ever has one kind of actor, a filter can skip it. */
  onlyActor?: ActorKind;
  load(q: AdapterQuery): Promise<TimelineEntry[]>;
}

function range(field: string, q: AdapterQuery): Record<string, unknown> {
  if (!q.before && !q.from) return {};
  return { [field]: { ...(q.before ? { lte: q.before } : {}), ...(q.from ? { gte: q.from } : {}) } };
}

const scoped = <T,>(workspaceId: string, fn: (tx: Tx) => Promise<T>) => withWorkspaceScope(workspaceId, fn);

export const TIMELINE_ADAPTERS: readonly TimelineAdapter[] = [
  {
    source: "file_change_log",
    async load(q) {
      // Workspace events carry workspace_id; older project events only the project.
      const rows = await prisma.fileChangeLog.findMany({
        where: { OR: [{ workspaceId: q.workspaceId }, { workspaceId: null, project: { workspaceId: q.workspaceId } }], ...range("createdAt", q) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.take,
        select: { id: true, createdAt: true, actor: true, action: true, summary: true, filePath: true, projectId: true, approvedBy: true },
      });
      return rows.map(fromFileChangeLog);
    },
  },
  {
    source: "agent_run_event",
    onlyActor: "agent",
    async load(q) {
      const rows = await scoped(q.workspaceId, (tx) =>
        tx.agentRunEvent.findMany({
          // Streamed text and token-usage rows are not steps.
          where: { workspaceId: q.workspaceId, type: { in: ["agui", "gate", "browser", "note"] }, ...range("createdAt", q) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: q.take,
          select: { id: true, createdAt: true, runId: true, type: true, summary: true, run: { select: { agentKey: true, kind: true, startedBy: true } } },
        }),
      );
      return rows.map((r) => fromAgentRunEvent({ ...r, type: String(r.type), run: r.run ? { ...r.run, kind: String(r.run.kind) } : null }));
    },
  },
  {
    source: "ops_audit_event",
    async load(q) {
      const rows = await scoped(q.workspaceId, (tx) =>
        tx.opsAuditEvent.findMany({
          where: { workspaceId: q.workspaceId, ...range("createdAt", q) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: q.take,
          select: { id: true, createdAt: true, entity: true, entityId: true, action: true, actor: true, summary: true },
        }),
      );
      return rows.map(fromOpsAuditEvent);
    },
  },
  {
    source: "composio_action_log",
    async load(q) {
      const rows = await scoped(q.workspaceId, (tx) =>
        tx.composioActionLog.findMany({
          where: { workspaceId: q.workspaceId, ...range("createdAt", q) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: q.take,
          select: { id: true, createdAt: true, appKey: true, toolName: true, status: true, riskTier: true, executedBy: true },
        }),
      );
      return rows.map(fromComposioActionLog);
    },
  },
  {
    source: "command_audit",
    onlyActor: "person",
    async load(q) {
      const rows = await scoped(q.workspaceId, (tx) =>
        tx.commandAudit.findMany({
          where: { workspaceId: q.workspaceId, ...range("createdAt", q) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: q.take,
          select: { id: true, createdAt: true, userId: true, kind: true, templateId: true, resultSummary: true },
        }),
      );
      return rows.map((r) => fromCommandAudit({ ...r, kind: String(r.kind) }));
    },
  },
  {
    source: "workspace_lifecycle_event",
    onlyActor: "person",
    async load(q) {
      const rows = await prisma.workspaceLifecycleEvent.findMany({
        where: { workspaceId: q.workspaceId, ...range("createdAt", q) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.take,
        select: { id: true, createdAt: true, actorUserId: true, action: true, workspaceName: true },
      });
      return rows.map(fromWorkspaceLifecycleEvent);
    },
  },
  {
    source: "mission_event",
    async load(q) {
      const rows = await scoped(q.workspaceId, (tx) =>
        tx.missionEvent.findMany({
          where: { workspaceId: q.workspaceId, ...range("ts", q) },
          orderBy: [{ ts: "desc" }, { id: "desc" }],
          take: q.take,
          select: { id: true, ts: true, missionId: true, actor: true, step: true, tool: true },
        }),
      );
      return rows.map(fromMissionEvent);
    },
  },
  {
    source: "media_audit_event",
    async load(q) {
      const rows = await prisma.mediaAuditEvent.findMany({
        where: { workspaceId: q.workspaceId, ...range("ts", q) },
        orderBy: [{ ts: "desc" }, { id: "desc" }],
        take: q.take,
        select: { id: true, ts: true, actor: true, action: true, subjectType: true, subjectId: true },
      });
      return rows.map((r) => fromMediaAuditEvent({ ...r, action: String(r.action) }));
    },
  },
  {
    source: "authority_audit_event",
    async load(q) {
      const rows = await prisma.authorityAuditEvent.findMany({
        where: { workspaceId: q.workspaceId, ...range("ts", q) },
        orderBy: [{ ts: "desc" }, { id: "desc" }],
        take: q.take,
        select: { id: true, ts: true, actor: true, action: true, entityType: true, entityId: true },
      });
      return rows.map(fromAuthorityAuditEvent);
    },
  },
  {
    source: "flywheel_audit_event",
    async load(q) {
      const rows = await prisma.flywheelAuditEvent.findMany({
        where: { workspaceId: q.workspaceId, ...range("ts", q) },
        orderBy: [{ ts: "desc" }, { id: "desc" }],
        take: q.take,
        select: { id: true, ts: true, actor: true, kind: true, correlationId: true },
      });
      return rows.map((r) => fromFlywheelAuditEvent({ ...r, kind: String(r.kind) }));
    },
  },
  {
    source: "esign_audit_event",
    async load(q) {
      const rows = await prisma.esignAuditEvent.findMany({
        where: { envelope: { workspaceId: q.workspaceId }, ...range("createdAt", q) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.take,
        select: { id: true, createdAt: true, actor: true, event: true, envelope: { select: { id: true, title: true } } },
      });
      return rows.map(fromEsignAuditEvent);
    },
  },
];
