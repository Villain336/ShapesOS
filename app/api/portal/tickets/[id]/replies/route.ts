// ShapesOS — Phase 10 (portal): POST /api/portal/tickets/[id]/replies { body }
// — the client's reply on one of their tickets (an inbound message; re-opens
// a pending/solved ticket; closed tickets refuse). portalGuard: portal
// cookie + CSRF + the ticket_write action (editor+).

import { portalError, portalGuard, readPortalJson } from "@/lib/portal/http";
import { replyPortalTicket } from "@/lib/portal/data";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await portalGuard(req, { section: "tickets", action: "ticket_write" });
  if (p instanceof Response) return p;
  try {
    const body = await readPortalJson(req);
    return Response.json(await replyPortalTicket(p, (await params).id, { body: body.body }), { status: 201 });
  } catch (err) {
    return portalError(err);
  }
}
