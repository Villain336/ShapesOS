// ShapesOS Phase 10 (ops-core): ticket conversation.
//   GET  → { ticket, messages, sla } (viewer+)
//   POST { body } → internal note (editor+; never emailed)

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { addTicketNote, slaState } from "@/lib/ops/helpdesk";
import { OpsNotFoundError } from "@/lib/ops/doctype";
import { validateBody, z } from "@/lib/api/validate";
import { ticketError, ticketGuard } from "../../_guard";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await ticketGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const out = await withWorkspaceScope(actor.workspaceId, async (tx) => {
      const ticket = await tx.opsTicket.findFirst({ where: { id, workspaceId: actor.workspaceId } });
      if (!ticket) throw new OpsNotFoundError("tickets", id);
      const messages = await tx.opsTicketMessage.findMany({ where: { ticketId: id, workspaceId: actor.workspaceId }, orderBy: { createdAt: "asc" }, take: 500 });
      return { ticket, messages, sla: slaState(ticket, new Date()) };
    });
    return Response.json(out);
  } catch (err) {
    return ticketError(err);
  }
}

const Note = z.object({ body: z.string().trim().min(1).max(50_000) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await ticketGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const parsed = validateBody(Note, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    const message = await withWorkspaceScope(actor.workspaceId, (tx) => addTicketNote(tx, actor, id, parsed.data.body));
    return Response.json({ message }, { status: 201 });
  } catch (err) {
    return ticketError(err);
  }
}
