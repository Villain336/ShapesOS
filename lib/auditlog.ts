// Marketr — shared audit writer for milestone 21 routes.
//
// Every M21 mutation writes a FileChangeLog row (spec §7 "Full audit
// coverage"). Workspace-scoped events use filePath "(workspace)" following
// the app/api/workspace/members convention. Secrets and credential blobs
// never appear in summaries.

import { prisma } from "./prisma";
import type { FileChangeAction } from "@prisma/client";

export interface AuditEvent {
  /** Null for workspace-scoped events. */
  projectId: string | null;
  workspaceId: string;
  action: FileChangeAction;
  summary: string;
  /** The user who performed the action ("user" actor). Defaults to "user". */
  actorUserId?: string;
  /** AI-loop events use actor "ai" instead. */
  actor?: "user" | "ai";
}

export async function auditEvent(event: AuditEvent): Promise<void> {
  const actor = event.actor ?? "user";
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: event.projectId,
        workspaceId: event.workspaceId,
        filePath: event.projectId ? `m21:${event.action}` : "(workspace)",
        actor,
        action: event.action,
        summary: event.summary.slice(0, 500),
        approvedBy: actor === "user" ? (event.actorUserId ?? null) : null,
      },
    })
    .catch(() => {});
}
