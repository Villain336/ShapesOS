// ShapesOS — Phase 12 (people): POST /api/ops/events/check-in
//   { code, eventId? } → { status, message, attendee? }
// Staff (editor+) scan a QR ticket (the ticket URL or the bare token). The
// signed token must be this workspace's (and this event's, when the screen
// is for one event); the attendee is marked checked-in ONCE — a second scan
// answers "already_checked_in" (200, not an error, so the scanner can show
// it). Forged / foreign / cancelled tickets answer "invalid" /
// "not_confirmed".

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard, optString, readJsonBody } from "@/lib/ops/finance/http";
import { checkInAttendee } from "@/lib/ops/events/checkin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const body = await readJsonBody(req);
    const code = optString(body?.code);
    if (!code || code.length > 2000) return Response.json({ error: "Scan or paste a ticket code" }, { status: 400 });
    const r = await withWorkspaceScope(actor.workspaceId, (tx) => checkInAttendee(tx, actor, code, { eventId: optString(body?.eventId) ?? null }));
    return Response.json(r, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return financeError(err);
  }
}
