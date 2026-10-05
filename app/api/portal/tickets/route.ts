// ShapesOS — Phase 10 (portal): POST /api/portal/tickets { subject, body } —
// open a helpdesk ticket as the signed-in client (requester = their sign-in
// email, contact = a linked contact) through the ops-core helpdesk service.
// portalGuard: portal cookie + CSRF + the ticket_write action (editor+).

import { portalError, portalGuard, readPortalJson } from "@/lib/portal/http";
import { createPortalTicket } from "@/lib/portal/data";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const p = await portalGuard(req, { section: "tickets", action: "ticket_write" });
  if (p instanceof Response) return p;
  try {
    const body = await readPortalJson(req);
    return Response.json(await createPortalTicket(p, { subject: body.subject, body: body.body }), { status: 201 });
  } catch (err) {
    return portalError(err);
  }
}
