// Marketr — scheduler audit writer (Phase B, W2).
//
// M21 routes write FileChangeLog rows via lib/auditlog's auditEvent, which is
// bound to the real Prisma client. The scheduler engine takes its db as a
// parameter (repo service convention, testable with fakes), so it has its own
// small writer here — same row shape, same conventions.

import type { FileChangeAction, PrismaClient } from "@prisma/client";

export interface SchedulerAuditEvent {
  projectId: string | null;
  workspaceId: string;
  action: FileChangeAction;
  summary: string;
  /** Approving user for approval-gated events; null for engine actor. */
  actorUserId?: string | null;
}

export async function schedulerAudit(
  db: Pick<PrismaClient, "fileChangeLog">,
  event: SchedulerAuditEvent,
): Promise<void> {
  await db.fileChangeLog
    .create({
      data: {
        projectId: event.projectId,
        workspaceId: event.workspaceId,
        filePath: event.projectId ? `scheduler:${event.action}` : "(workspace)",
        actor: "ai",
        action: event.action,
        summary: event.summary.slice(0, 500),
        approvedBy: event.actorUserId ?? null,
      },
    })
    .catch(() => {
      // Audit must never break the engine; failures are swallowed like the
      // M21 auditEvent helper (which also catches).
    });
}
