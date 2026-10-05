// ShapesOS — Phase 12 (people): create/patch rules for events, sessions and
// ticket types (OPS_ENTITIES hooks, lib/ops/events/entities.ts).
//
//   events        /events/<slug> is globally unique: a derived slug gets a
//                 short suffix on collision, a chosen one answers 409; times
//                 must run forward; draft → published (needs an active
//                 ticket type) → draft / cancelled; cancelled is final; the
//                 reminder sequence must be this workspace's.
//   sessions      belong to an event of this workspace; capacity never below
//                 the seats already held.
//   ticket types  belong to the event (and to one of its sessions, if
//                 scoped); quantity never below what is sold; the sales
//                 window runs forward.
// The seat counters themselves only move through capacity.ts.

import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { OpsError, OpsNotFoundError, type OpsActor } from "../doctype";
import { RESERVED_EVENT_SLUGS, slugifyEventTitle } from "./pricing";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

export const EVENT_STATUS_FLOW: Readonly<Record<string, string[]>> = {
  draft: ["published", "cancelled"],
  published: ["draft", "cancelled"],
  cancelled: [],
};

function date(v: unknown, field: string): Date {
  const d = new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) throw new OpsError(400, `Invalid ${field}: must be an ISO-8601 date`);
  return d;
}

function assertForward(start: Date, end: Date, what: string) {
  if (end.getTime() <= start.getTime()) throw new OpsError(400, `${what} must end after it starts`);
}

async function assertSequence(tx: Tx, workspaceId: string, id: unknown) {
  if (id == null) return;
  const seq = await tx.nurtureSequence.findFirst({ where: { id: String(id), workspaceId }, select: { status: true } });
  if (!seq) throw new OpsError(400, "That reminder sequence isn't in this workspace");
  if (seq.status === "archived") throw new OpsError(422, "That reminder sequence is archived");
}

async function defaultCurrency(tx: Tx, workspaceId: string): Promise<string> {
  const s = await tx.opsFinanceSettings.findUnique({ where: { workspaceId }, select: { currency: true } });
  return s?.currency ?? "USD";
}

export async function createEventRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const ws = actor.workspaceId;
  const startsAt = date(body.startsAt, "startsAt");
  const endsAt = date(body.endsAt, "endsAt");
  assertForward(startsAt, endsAt, "The event");
  await assertSequence(tx, ws, body.reminderSequenceId);
  const chosen = typeof body.slug === "string" ? body.slug : null;
  if (chosen && RESERVED_EVENT_SLUGS.has(chosen)) throw new OpsError(409, `The address /events/${chosen} is reserved — choose another`);
  const derived = slugifyEventTitle(String(body.title));
  const base = chosen ?? (RESERVED_EVENT_SLUGS.has(derived) ? `${derived}-event` : derived);
  const currency = (body.currency as string | undefined) ?? (await defaultCurrency(tx, ws));
  // /events/<slug> is unique across ALL workspaces, which RLS hides from
  // us: insert with ON CONFLICT DO NOTHING and retry a derived slug.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, 72)}-${randomBytes(3).toString("hex")}`;
    const id = `ev_${randomUUID().replace(/-/g, "")}`;
    const created = await tx.opsEvent.createMany({
      data: [
        {
          id,
          workspaceId: ws,
          title: String(body.title),
          slug,
          description: (body.description as string | undefined) ?? null,
          venue: (body.venue as string | undefined) ?? null,
          webinarUrl: (body.webinarUrl as string | undefined) ?? null,
          timezone: (body.timezone as string | undefined) ?? "UTC",
          startsAt,
          endsAt,
          capacity: (body.capacity as number | undefined) ?? null,
          currency,
          reminderSequenceId: (body.reminderSequenceId as string | undefined) ?? null,
          status: "draft",
          createdBy: actor.userId,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 1) return (await tx.opsEvent.findFirstOrThrow({ where: { id, workspaceId: ws } })) as unknown as Row;
    if (chosen) throw new OpsError(409, `The address /events/${chosen} is taken — choose another`);
  }
  throw new OpsError(409, "Couldn't find a free event address — set a slug");
}

export async function patchEventRow(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const ws = actor.workspaceId;
  const data: Row = { ...patch };
  const from = String(existing.status);
  if (typeof patch.status === "string" && patch.status !== from) {
    if (!(EVENT_STATUS_FLOW[from] ?? []).includes(patch.status)) throw new OpsError(409, `An event can't move from ${from} to ${patch.status}`);
    if (patch.status === "published") {
      const tickets = await tx.opsEventTicketType.count({ where: { workspaceId: ws, eventId: id, active: true } });
      if (tickets === 0) throw new OpsError(422, "Add at least one active ticket type before publishing");
    }
  } else if (from === "cancelled") {
    throw new OpsError(409, "A cancelled event can't be edited");
  }
  const startsAt = patch.startsAt !== undefined ? date(patch.startsAt, "startsAt") : (existing.startsAt as Date);
  const endsAt = patch.endsAt !== undefined ? date(patch.endsAt, "endsAt") : (existing.endsAt as Date);
  assertForward(startsAt, endsAt, "The event");
  if (patch.startsAt !== undefined) data.startsAt = startsAt;
  if (patch.endsAt !== undefined) data.endsAt = endsAt;
  if (typeof patch.capacity === "number" && patch.capacity < Number(existing.reservedCount ?? 0)) {
    throw new OpsError(409, `${String(existing.reservedCount)} seats are already taken — capacity can't go below that`);
  }
  if (patch.reminderSequenceId !== undefined) await assertSequence(tx, ws, patch.reminderSequenceId);
  if (typeof patch.slug === "string" && patch.slug !== existing.slug) {
    if (RESERVED_EVENT_SLUGS.has(patch.slug)) throw new OpsError(409, `The address /events/${patch.slug} is reserved — choose another`);
    await tx.$executeRawUnsafe("SAVEPOINT ops_event_slug");
    try {
      const row = await tx.opsEvent.update({ where: { id, workspaceId: ws }, data });
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT ops_event_slug");
      return row as unknown as Row;
    } catch (err) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT ops_event_slug");
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new OpsError(409, `The address /events/${patch.slug} is taken — choose another`);
      }
      throw err;
    }
  }
  // Status-guarded so two racing publish/cancel clicks can't both land.
  const moved = await tx.opsEvent.updateMany({ where: { id, workspaceId: ws, status: from as "draft" | "published" | "cancelled" }, data });
  if (moved.count !== 1) throw new OpsError(409, "The event changed concurrently — reload");
  return (await tx.opsEvent.findFirstOrThrow({ where: { id, workspaceId: ws } })) as unknown as Row;
}

async function loadEvent(tx: Tx, workspaceId: string, eventId: string) {
  const ev = await tx.opsEvent.findFirst({ where: { id: eventId, workspaceId } });
  if (!ev) throw new OpsNotFoundError("events", eventId);
  if (ev.status === "cancelled") throw new OpsError(409, "This event is cancelled");
  return ev;
}

export async function createSessionRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const ev = await loadEvent(tx, actor.workspaceId, String(body.eventId));
  const startsAt = date(body.startsAt, "startsAt");
  const endsAt = date(body.endsAt, "endsAt");
  assertForward(startsAt, endsAt, "The session");
  return (await tx.opsEventSession.create({
    data: {
      workspaceId: actor.workspaceId,
      eventId: ev.id,
      title: String(body.title),
      venue: (body.venue as string | undefined) ?? null,
      webinarUrl: (body.webinarUrl as string | undefined) ?? null,
      startsAt,
      endsAt,
      capacity: (body.capacity as number | undefined) ?? null,
      position: Number(body.position ?? 0),
    },
  })) as unknown as Row;
}

export async function patchSessionRow(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const data: Row = { ...patch };
  const startsAt = patch.startsAt !== undefined ? date(patch.startsAt, "startsAt") : (existing.startsAt as Date);
  const endsAt = patch.endsAt !== undefined ? date(patch.endsAt, "endsAt") : (existing.endsAt as Date);
  assertForward(startsAt, endsAt, "The session");
  if (patch.startsAt !== undefined) data.startsAt = startsAt;
  if (patch.endsAt !== undefined) data.endsAt = endsAt;
  if (typeof patch.capacity === "number" && patch.capacity < Number(existing.reservedCount ?? 0)) {
    throw new OpsError(409, `${String(existing.reservedCount)} seats are already taken — capacity can't go below that`);
  }
  return (await tx.opsEventSession.update({ where: { id, workspaceId: actor.workspaceId }, data })) as unknown as Row;
}

function assertWindow(start: Date | null, end: Date | null) {
  if (start && end && end.getTime() <= start.getTime()) throw new OpsError(400, "The sales window must end after it starts");
}

export async function createTicketTypeRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const ev = await loadEvent(tx, actor.workspaceId, String(body.eventId));
  let sessionId: string | null = null;
  if (typeof body.sessionId === "string") {
    const s = await tx.opsEventSession.findFirst({ where: { id: body.sessionId, workspaceId: actor.workspaceId, eventId: ev.id }, select: { id: true } });
    if (!s) throw new OpsError(400, "That session isn't part of this event");
    sessionId = s.id;
  }
  const salesStartAt = body.salesStartAt != null ? date(body.salesStartAt, "salesStartAt") : null;
  const salesEndAt = body.salesEndAt != null ? date(body.salesEndAt, "salesEndAt") : null;
  assertWindow(salesStartAt, salesEndAt);
  return (await tx.opsEventTicketType.create({
    data: {
      workspaceId: actor.workspaceId,
      eventId: ev.id,
      sessionId,
      name: String(body.name),
      description: (body.description as string | undefined) ?? null,
      priceCents: Number(body.priceCents ?? 0),
      quantity: (body.quantity as number | undefined) ?? null,
      salesStartAt,
      salesEndAt,
      maxPerOrder: Number(body.maxPerOrder ?? 10),
      active: body.active !== false,
      position: Number(body.position ?? 0),
    },
  })) as unknown as Row;
}

export async function patchTicketTypeRow(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const data: Row = { ...patch };
  const salesStartAt = patch.salesStartAt !== undefined ? (patch.salesStartAt === null ? null : date(patch.salesStartAt, "salesStartAt")) : (existing.salesStartAt as Date | null);
  const salesEndAt = patch.salesEndAt !== undefined ? (patch.salesEndAt === null ? null : date(patch.salesEndAt, "salesEndAt")) : (existing.salesEndAt as Date | null);
  assertWindow(salesStartAt, salesEndAt);
  if (patch.salesStartAt !== undefined) data.salesStartAt = salesStartAt;
  if (patch.salesEndAt !== undefined) data.salesEndAt = salesEndAt;
  if (typeof patch.quantity === "number" && patch.quantity < Number(existing.soldCount ?? 0)) {
    throw new OpsError(409, `${String(existing.soldCount)} of these are already taken — quantity can't go below that`);
  }
  return (await tx.opsEventTicketType.update({ where: { id, workspaceId: actor.workspaceId }, data })) as unknown as Row;
}
