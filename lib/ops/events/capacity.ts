// ShapesOS — Phase 12 (people): seat reservation — the no-oversell guard.
//
// A registration holds seats on up to three counters: the event
// (reserved_count ≤ capacity), the ticket's session (same) and the ticket
// type (sold_count ≤ quantity). Each counter moves with ONE conditional
// UPDATE:
//     UPDATE … SET n = n + q WHERE id = … AND (cap IS NULL OR n + q <= cap)
// Postgres row-locks the counter row; a concurrent registration blocks on
// that lock and then RE-EVALUATES the WHERE against the committed count
// (READ COMMITTED), so the last seat goes to exactly one buyer and everyone
// else matches 0 rows → "sold out" (the whole transaction rolls back,
// releasing what it had taken). Counters are always taken in the same order
// (event → session → ticket type) so two registrations can't deadlock. The
// CHECK constraints (reserved/sold ≤ capacity, ≥ 0) are the database
// backstop if anything ever bypassed this module.
//
// Releases (cancel, unpaid hold expired) run the mirror decrement exactly
// once — callers claim the registration's status first.

import type { Prisma } from "@prisma/client";
import { OpsError } from "../doctype";

type Tx = Prisma.TransactionClient;

export interface SeatTarget {
  workspaceId: string;
  eventId: string;
  sessionId: string | null;
  ticketTypeId: string;
  quantity: number;
}

export class SoldOutError extends OpsError {
  readonly code = "sold_out";
  constructor(what: string) {
    super(409, `Sold out — not enough ${what} left.`);
    this.name = "SoldOutError";
  }
}

export async function reserveSeats(tx: Tx, t: SeatTarget): Promise<void> {
  if (!Number.isInteger(t.quantity) || t.quantity < 1) throw new OpsError(400, "Quantity must be at least 1");
  const q = t.quantity;
  const ev = await tx.$executeRaw`
    UPDATE "ops_events" SET "reserved_count" = "reserved_count" + ${q}, "updated_at" = now()
     WHERE "id" = ${t.eventId} AND "workspace_id" = ${t.workspaceId}
       AND ("capacity" IS NULL OR "reserved_count" + ${q} <= "capacity")`;
  if (ev !== 1) throw new SoldOutError("seats at this event");
  if (t.sessionId) {
    const s = await tx.$executeRaw`
      UPDATE "ops_event_sessions" SET "reserved_count" = "reserved_count" + ${q}, "updated_at" = now()
       WHERE "id" = ${t.sessionId} AND "workspace_id" = ${t.workspaceId} AND "event_id" = ${t.eventId}
         AND ("capacity" IS NULL OR "reserved_count" + ${q} <= "capacity")`;
    if (s !== 1) throw new SoldOutError("seats in this session");
  }
  const tt = await tx.$executeRaw`
    UPDATE "ops_event_ticket_types" SET "sold_count" = "sold_count" + ${q}, "updated_at" = now()
     WHERE "id" = ${t.ticketTypeId} AND "workspace_id" = ${t.workspaceId} AND "event_id" = ${t.eventId}
       AND "active" AND ("quantity" IS NULL OR "sold_count" + ${q} <= "quantity")`;
  if (tt !== 1) throw new SoldOutError("tickets of this type");
}

export async function releaseSeats(tx: Tx, t: SeatTarget): Promise<void> {
  const q = t.quantity;
  await tx.$executeRaw`
    UPDATE "ops_events" SET "reserved_count" = "reserved_count" - ${q}, "updated_at" = now()
     WHERE "id" = ${t.eventId} AND "workspace_id" = ${t.workspaceId}`;
  if (t.sessionId) {
    await tx.$executeRaw`
      UPDATE "ops_event_sessions" SET "reserved_count" = "reserved_count" - ${q}, "updated_at" = now()
       WHERE "id" = ${t.sessionId} AND "workspace_id" = ${t.workspaceId}`;
  }
  await tx.$executeRaw`
    UPDATE "ops_event_ticket_types" SET "sold_count" = "sold_count" - ${q}, "updated_at" = now()
     WHERE "id" = ${t.ticketTypeId} AND "workspace_id" = ${t.workspaceId}`;
}
