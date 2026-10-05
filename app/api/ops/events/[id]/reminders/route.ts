// ShapesOS — Phase 12 (people): POST /api/ops/events/[id]/reminders.
// Catch-up: enroll every confirmed registration of the event that isn't yet
// in the event's reminder sequence (normally this happens right after each
// confirmation). The sequence's own sends stay approval-gated by the
// nurture engine. Editor+.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard } from "@/lib/ops/finance/http";
import { OpsError } from "@/lib/ops/doctype";
import { enrollEventReminders } from "@/lib/ops/events/reminders";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const ev = await withWorkspaceScope(actor.workspaceId, (tx) => tx.opsEvent.findFirst({ where: { id, workspaceId: actor.workspaceId }, select: { reminderSequenceId: true } }));
    if (!ev) throw new OpsError(404, "Event not found");
    if (!ev.reminderSequenceId) throw new OpsError(422, "Choose a reminder sequence for this event first");
    return Response.json(await enrollEventReminders(actor.workspaceId, id));
  } catch (err) {
    return financeError(err);
  }
}
