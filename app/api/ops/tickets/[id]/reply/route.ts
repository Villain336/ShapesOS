// ShapesOS Phase 10 (ops-core): POST /api/ops/tickets/[id]/reply
//   { body, status?: "pending" | "solved" | "open" }
// Emails the requester through the messaging email provider (Resend, or the
// labelled fake provider in dev) with the workspace support address as
// Reply-To and "[#n]" in the subject so the answer threads back. Metered;
// a failed send is recorded on the message, never dropped. Editor+.

import { sendTicketReply } from "@/lib/ops/helpdesk";
import { validateBody, z } from "@/lib/api/validate";
import { ticketError, ticketGuard } from "../../_guard";

export const dynamic = "force-dynamic";

const Reply = z.object({ body: z.string().trim().min(1).max(50_000), status: z.enum(["pending", "solved", "open"]).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await ticketGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    const parsed = validateBody(Reply, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    const result = await sendTicketReply(actor, id, parsed.data);
    return Response.json(result, { status: result.sent ? 200 : 502 });
  } catch (err) {
    return ticketError(err);
  }
}
