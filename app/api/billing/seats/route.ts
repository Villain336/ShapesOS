// ShapesOS — extra seats (Phase 15.3 pricing: base fee + seats + credits).
// GET  /api/billing/seats?workspaceId= → SeatSummary (included, used, extra,
//      approved ceiling, quantity on Stripe, price per seat, sync state).
// POST /api/billing/seats { workspaceId, approvedExtraSeats, confirmSeatCharge }
//      → set the approved extra-seat ceiling. Raising it is a money decision:
//      it needs confirmSeatCharge: true (the dialog showed the price) and a
//      billable subscription; without it → 402 seat_confirmation_required.
//      Lowering below the extra seats in use → 400 (remove members first).
// POST /api/billing/seats { workspaceId, action: "sync" } → re-sync the
//      Stripe seat quantity (idempotent; never above the approved ceiling).
// Admin-only (requireWorkspaceAccess "admin"); every change is audit-logged.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest } from "@/lib/route-utils";
import { HttpError, errorResponse } from "@/lib/api/errors";
import { getSeatSummary, setApprovedExtraSeats, syncSeatsBestEffort } from "@/lib/billing/seats-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;
  return Response.json(await getSeatSummary(access.workspaceId));
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { workspaceId?: unknown; approvedExtraSeats?: unknown; confirmSeatCharge?: unknown; action?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON");
  }
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "admin");
  if ("error" in access) return access.error;
  try {
    if (body?.action === "sync") {
      const sync = await syncSeatsBestEffort(access.workspaceId);
      return Response.json({ sync, seats: await getSeatSummary(access.workspaceId) }, { status: sync.ok ? 200 : 502 });
    }
    if (typeof body?.approvedExtraSeats !== "number") return badRequest("approvedExtraSeats (a whole number) or action: \"sync\" is required");
    const seats = await setApprovedExtraSeats(access.workspaceId, body.approvedExtraSeats, {
      confirmed: body.confirmSeatCharge === true,
      actor: { userId: user.id, label: user.email ?? user.id },
    });
    return Response.json({ seats });
  } catch (err) {
    if (err instanceof HttpError && err.code === "seat_confirmation_required") {
      return Response.json({ error: err.message, code: err.code }, { status: 402 });
    }
    return errorResponse(err, "POST /api/billing/seats");
  }
}
