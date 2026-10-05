// ShapesOS — Phase 10 (portal): POST /api/portal/quotes/[id]/decision
// { decision: "accept" | "decline" }. portalGuard: portal cookie + CSRF + the
// quote_decide action (admin clients). The move goes through the quotes
// entity's status machine (sent → accepted | declined, status-guarded, so it
// lands once) and is audited with actor client:<id>.

import { portalError, portalGuard, readPortalJson } from "@/lib/portal/http";
import { decidePortalQuote } from "@/lib/portal/data";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await portalGuard(req, { section: "quotes", action: "quote_decide" });
  if (p instanceof Response) return p;
  try {
    const body = await readPortalJson(req);
    if (body.decision !== "accept" && body.decision !== "decline") {
      return Response.json({ error: "decision must be accept or decline" }, { status: 400 });
    }
    return Response.json(await decidePortalQuote(p, (await params).id, body.decision));
  } catch (err) {
    return portalError(err);
  }
}
