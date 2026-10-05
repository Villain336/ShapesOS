// ShapesOS — Phase 12 (people): check-in, ONCE per attendee.
//
// The scanner sends whatever it read (the ticket URL or the bare token).
//   1. the token's signature is verified (forged / mangled → "invalid");
//   2. it must belong to THIS workspace (and to the event being scanned,
//      when the screen is for one event) — otherwise "invalid", never a
//      cross-tenant hint;
//   3. the attendee row must exist with the same ticket code (constant-time
//      compare) — a cancelled registration's ticket stops working;
//   4. ONE status-guarded UPDATE … WHERE checked_in_at IS NULL AND status =
//      'confirmed' marks it. Two simultaneous scans of the same ticket: one
//      wins (count 1, "checked_in"), the other matches 0 rows and reports
//      "already checked in" with the time of the first scan.

import type { Prisma } from "@prisma/client";
import type { OpsActor } from "../doctype";
import { extractTicketToken, sameTicketCode, verifyTicket } from "./tickets";

type Tx = Prisma.TransactionClient;

export type CheckInStatus = "checked_in" | "already_checked_in" | "not_confirmed" | "invalid";

export interface CheckInResult {
  status: CheckInStatus;
  message: string;
  attendee?: { id: string; name: string; email: string | null; ticketType: string; eventId: string; eventTitle: string; checkedInAt: Date | null };
}

const invalid = (message = "This isn't a valid ticket for this event."): CheckInResult => ({ status: "invalid", message });

export async function checkInAttendee(tx: Tx, actor: OpsActor, scanned: unknown, opts: { eventId?: string | null; now?: Date } = {}): Promise<CheckInResult> {
  const token = extractTicketToken(scanned);
  const claims = token ? verifyTicket(token) : null;
  if (!claims || claims.workspaceId !== actor.workspaceId) return invalid();
  if (opts.eventId && claims.eventId !== opts.eventId) return invalid("This ticket is for a different event.");
  const ws = actor.workspaceId;
  const a = await tx.opsEventAttendee.findFirst({
    where: { id: claims.attendeeId, workspaceId: ws, eventId: claims.eventId },
    include: { ticketType: { select: { name: true } }, event: { select: { title: true } } },
  });
  if (!a || !sameTicketCode(a.ticketCode, claims.ticketCode)) return invalid();
  const view = (checkedInAt: Date | null) => ({ id: a.id, name: a.name, email: a.email, ticketType: a.ticketType.name, eventId: a.eventId, eventTitle: a.event.title, checkedInAt });
  if (a.status !== "confirmed") {
    return { status: "not_confirmed", message: a.status === "pending" ? "Payment for this ticket hasn't been confirmed." : `This ticket is ${a.status}.`, attendee: view(a.checkedInAt) };
  }
  const now = opts.now ?? new Date();
  const claimed = await tx.opsEventAttendee.updateMany({
    where: { id: a.id, workspaceId: ws, status: "confirmed", checkedInAt: null },
    data: { checkedInAt: now, checkedInBy: actor.userId },
  });
  if (claimed.count !== 1) {
    const cur = await tx.opsEventAttendee.findFirst({ where: { id: a.id, workspaceId: ws }, select: { checkedInAt: true } });
    return {
      status: "already_checked_in",
      message: `Already checked in${cur?.checkedInAt ? ` at ${cur.checkedInAt.toISOString().slice(11, 16)} UTC` : ""}.`,
      attendee: view(cur?.checkedInAt ?? null),
    };
  }
  await tx.opsAuditEvent.create({
    data: { workspaceId: ws, entity: "event-attendees", entityId: a.id, action: "check_in", actor: actor.userId, summary: `${a.name} checked in to "${a.event.title}" (${a.ticketType.name})` },
  });
  return { status: "checked_in", message: `${a.name} is checked in.`, attendee: view(now) };
}
