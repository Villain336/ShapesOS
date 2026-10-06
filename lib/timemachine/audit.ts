// ShapesOS — Phase 18.3 (WS=flow): Time Machine's audit rows (FileChangeLog,
// the workspace audit log). A person's action is actor "user" with their id
// as approvedBy; the scheduler / retention is actor "system". Summaries carry
// ids and counts, never data.

import type { FileChangeAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function timeMachineAudit(workspaceId: string, action: FileChangeAction, summary: string, userId: string | null): Promise<void> {
  await prisma.fileChangeLog
    .create({
      data: {
        workspaceId,
        projectId: null,
        filePath: "(workspace)",
        actor: userId ? "user" : "system",
        action,
        summary: summary.slice(0, 500),
        approvedBy: userId,
      },
    })
    .catch(() => undefined);
}
