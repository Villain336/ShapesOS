// Marketr — Legal/Compliance slice 2 API.
// PATCH /api/legal/deadlines/[id] — tenant edits one deadline: due date,
// recurrence, note, or status (editor). Marking "done" on a recurring
// deadline computes the next occurrence from the confirmed date — computed,
// never invented.
// DELETE /api/legal/deadlines/[id] — tenant removes a deadline (editor).
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError } from "@/lib/legal/types";
import type { DeadlineRecurrence } from "@/lib/legal/deadlines";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as {
      dueDate?: unknown;
      recurrence?: unknown;
      note?: unknown;
      status?: unknown;
    };
    const store = new PrismaLegalStore(prisma);
    const deadline = await store.updateDeadline(workspace.id, id, {
      dueDate:
        body.dueDate === undefined
          ? undefined
          : body.dueDate === null
            ? null
            : typeof body.dueDate === "string"
              ? body.dueDate
              : undefined,
      recurrence:
        typeof body.recurrence === "string"
          ? (body.recurrence as DeadlineRecurrence)
          : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
      status:
        body.status === "open" || body.status === "done" || body.status === "dismissed"
          ? body.status
          : undefined,
    });
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, deadline });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_DEADLINE" ? 404 : e.code === "DEADLINE_NOT_OPEN" ? 409 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const store = new PrismaLegalStore(prisma);
    await store.deleteDeadline(workspace.id, id);
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, deleted: true });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_DEADLINE" ? 404 : e.code === "DEADLINE_NOT_OPEN" ? 409 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}
