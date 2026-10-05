// ShapesOS — Phase 12 (people): event registrations and attendees.
//
// registerCore (inside the caller's tenant transaction) is the ONE writer:
//   1. availability + price from lib/ops/events/pricing.ts (sales window,
//      max per order, seats left) — client prices never enter;
//   2. the registrant (and each named guest with an email) is matched to an
//      OpsContact by email or created — race-safe INSERT … ON CONFLICT;
//   3. seats are reserved on the event / session / ticket counters
//      (lib/ops/events/capacity.ts — row-locked, never oversold);
//   4. a free (or staff "comp") registration is CONFIRMED at once; a paid one
//      is PENDING with a hold that expires (unpaid holds are released).
// Paid registrations go to the workspace's OWN Stripe Checkout (the FINANCE
// integration, lib/ops/finance/stripe.ts — never the platform key) and are
// confirmed ONLY by the Stripe-signed tenant webhook (handleEventCheckoutEvent):
// status-guarded pending → confirmed, an OpsPayment charge, and a journal
// entry Dr Cash / Cr Sales keyed event_registration:<id>:paid — once.
// Expired / failed Checkout Sessions release the seats.
//
// UNVERIFIED-LIVE: exercised against a stub Stripe client in tests.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OpsError, OpsNotFoundError, type OpsActor } from "../doctype";
import { realStripe, tenantKeys, type StripeFactory } from "../finance/stripe";
import { postEventTicketSale } from "../finance/posting";
import { fmtMoney } from "../finance/money";
import { releaseSeats, reserveSeats, SoldOutError } from "./capacity";
import { normalizeEmail, priceRegistration, ticketAvailability, TicketRuleError } from "./pricing";
import { newTicketCode, signRegistrationView } from "./tickets";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

/** Stripe's minimum Checkout lifetime is 30 minutes; holds last a little longer. */
export const EVENT_CHECKOUT_TTL_S = 35 * 60;
/** Unpaid holds are swept this long after their expiry (late webhooks win). */
export const HOLD_SWEEP_GRACE_MS = 10 * 60_000;

export const EVENTS_PUBLIC_ACTOR = "event-registration";

async function audit(tx: Tx, actor: OpsActor, entity: string, id: string | null, action: string, summary: string) {
  await tx.opsAuditEvent.create({
    data: { workspaceId: actor.workspaceId, entity, entityId: id, action, actor: actor.userId, summary: summary.slice(0, 2000) },
  });
}

export function registrationLabel(id: string): string {
  return `REG-${id.slice(-6).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/** The workspace's OpsContact for this email — matched, or created (race-safe). */
export async function matchOrCreateContact(tx: Tx, workspaceId: string, name: string, email: string): Promise<string> {
  const e = normalizeEmail(email);
  if (!e) throw new OpsError(400, "Enter a valid email address");
  const id = `ct_${randomUUID().replace(/-/g, "")}`;
  await tx.$executeRaw`
    INSERT INTO "ops_contacts" ("id", "workspace_id", "name", "email", "notes", "created_at", "updated_at")
    VALUES (${id}, ${workspaceId}, ${name.slice(0, 200)}, ${e}, ${"Added by an event registration"}, now(), now())
    ON CONFLICT ("workspace_id", "email") DO NOTHING`;
  const c = await tx.opsContact.findFirst({ where: { workspaceId, email: e }, select: { id: true } });
  if (!c) throw new OpsError(500, "Contact could not be matched");
  return c.id;
}

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

export interface RegisterInput {
  ticketTypeId: string;
  quantity: number;
  name: string;
  email: string;
  attendees?: Array<{ name: string; email?: string | null }>;
  source: "public" | "staff" | "agent";
  /** Staff only: complimentary seats on a paid ticket. */
  comp?: boolean;
  now?: Date;
}

export interface RegisterOutcome {
  registration: Prisma.OpsEventRegistrationGetPayload<object>;
  attendees: Array<Prisma.OpsEventAttendeeGetPayload<object>>;
  event: Prisma.OpsEventGetPayload<object>;
  ticketName: string;
  needsPayment: boolean;
}

/** Release unpaid holds of this event whose checkout has lapsed. */
export async function sweepExpiredHolds(tx: Tx, actor: OpsActor, eventId: string, now: Date = new Date()): Promise<number> {
  const stale = await tx.opsEventRegistration.findMany({
    where: { workspaceId: actor.workspaceId, eventId, status: "pending", expiresAt: { lt: new Date(now.getTime() - HOLD_SWEEP_GRACE_MS) } },
    select: { id: true },
    take: 50,
  });
  let n = 0;
  for (const r of stale) if (await endRegistration(tx, actor, r.id, "expired", "unpaid hold expired")) n += 1;
  return n;
}

/** Which limit is short, in reserveSeats() order (event → session → ticket type). PURE. */
function soldOutFor(
  t: { quantity: number | null; soldCount: number },
  ev: { capacity: number | null; reservedCount: number },
  session: { capacity: number | null; reservedCount: number } | null,
  quantity: number,
): SoldOutError {
  const left = (cap: number | null, used: number) => (cap == null ? Infinity : cap - used);
  if (left(ev.capacity, ev.reservedCount) < quantity) return new SoldOutError("seats at this event");
  if (session && left(session.capacity, session.reservedCount) < quantity) return new SoldOutError("seats in this session");
  return new SoldOutError("tickets of this type");
}

export async function registerCore(tx: Tx, actor: OpsActor, input: RegisterInput): Promise<RegisterOutcome> {
  const ws = actor.workspaceId;
  const now = input.now ?? new Date();
  const ticket = await tx.opsEventTicketType.findFirst({ where: { id: input.ticketTypeId, workspaceId: ws } });
  if (!ticket) throw new OpsNotFoundError("event-ticket-types", input.ticketTypeId);
  const event = await tx.opsEvent.findFirstOrThrow({ where: { id: ticket.eventId, workspaceId: ws } });
  await sweepExpiredHolds(tx, actor, event.id, now);
  // Fresh counters (the sweep may have released seats).
  const [t, ev, session] = await Promise.all([
    tx.opsEventTicketType.findFirstOrThrow({ where: { id: ticket.id, workspaceId: ws } }),
    tx.opsEvent.findFirstOrThrow({ where: { id: event.id, workspaceId: ws } }),
    ticket.sessionId ? tx.opsEventSession.findFirst({ where: { id: ticket.sessionId, workspaceId: ws } }) : Promise.resolve(null),
  ]);
  // Staff may register into a draft event (e.g. a private preview); the
  // public page only ever sees published events.
  const asEvent = input.source === "public" ? ev : { ...ev, status: ev.status === "cancelled" ? "cancelled" : "published" };
  const availability = ticketAvailability(t, asEvent, session, now);
  let price: { unitPriceCents: number; amountCents: number };
  try {
    price = priceRegistration(t, availability, input.quantity, { comp: input.comp && input.source !== "public" });
  } catch (err) {
    // Not enough seats is the SAME condition whether this read already sees
    // the counters full or reserveSeats() loses the race a moment later —
    // both surface as SoldOutError (callers and the UI branch on it).
    const shortOfSeats =
      (availability.state === "sold_out" || availability.state === "on_sale") &&
      availability.remaining !== null &&
      input.quantity > availability.remaining;
    if (err instanceof TicketRuleError && err.status === 409 && shortOfSeats) {
      throw soldOutFor(t, ev, session, input.quantity);
    }
    if (err instanceof TicketRuleError) throw new OpsError(err.status, err.message);
    throw err;
  }
  const email = normalizeEmail(input.email);
  if (!email) throw new OpsError(400, "Enter a valid email address");
  const name = input.name.trim().slice(0, 200);
  if (!name) throw new OpsError(400, "Enter your name");
  const guests = input.attendees ?? [];
  if (guests.length > input.quantity) throw new OpsError(400, "More attendee names than tickets");

  const contactId = await matchOrCreateContact(tx, ws, name, email);
  await reserveSeats(tx, { workspaceId: ws, eventId: ev.id, sessionId: t.sessionId, ticketTypeId: t.id, quantity: input.quantity });

  const free = price.amountCents === 0;
  const status = free ? "confirmed" : "pending";
  const registration = await tx.opsEventRegistration.create({
    data: {
      workspaceId: ws,
      eventId: ev.id,
      ticketTypeId: t.id,
      contactId,
      name,
      email,
      quantity: input.quantity,
      unitPriceCents: price.unitPriceCents,
      amountCents: price.amountCents,
      currency: ev.currency,
      status,
      source: input.source,
      confirmedAt: free ? now : null,
      expiresAt: free ? null : new Date(now.getTime() + EVENT_CHECKOUT_TTL_S * 1000),
      createdBy: actor.userId,
    },
  });
  const rows: Prisma.OpsEventAttendeeCreateManyInput[] = [];
  for (let i = 0; i < input.quantity; i++) {
    const g = guests[i];
    const gEmail = g?.email ? normalizeEmail(g.email) : null;
    if (g?.email && !gEmail) throw new OpsError(400, `Attendee ${i + 1}: enter a valid email address`);
    const gName = g?.name?.trim().slice(0, 200) || (i === 0 ? name : `${name} (guest ${i + 1})`);
    rows.push({
      workspaceId: ws,
      eventId: ev.id,
      registrationId: registration.id,
      ticketTypeId: t.id,
      contactId: gEmail && gEmail !== email ? await matchOrCreateContact(tx, ws, gName, gEmail) : contactId,
      name: gName,
      email: gEmail ?? (i === 0 ? email : null),
      ticketCode: newTicketCode(),
      status,
    });
  }
  await tx.opsEventAttendee.createMany({ data: rows });
  const attendees = await tx.opsEventAttendee.findMany({ where: { workspaceId: ws, registrationId: registration.id }, orderBy: { createdAt: "asc" } });
  await audit(
    tx,
    actor,
    "event-registrations",
    registration.id,
    "create",
    `${registrationLabel(registration.id)}: ${input.quantity} × "${t.name}" for "${ev.title}" by ${email} (${input.source}${input.comp ? ", comp" : ""}) — ${free ? "confirmed" : `pending payment of ${fmtMoney(price.amountCents, ev.currency)}`}`,
  );
  return { registration, attendees, event: ev, ticketName: t.name, needsPayment: !free };
}

/**
 * End a registration that still holds seats (pending or confirmed) and
 * release them — exactly once (status-guarded claim). False when it was
 * already over.
 */
export async function endRegistration(tx: Tx, actor: OpsActor, id: string, to: "cancelled" | "expired", reason: string): Promise<boolean> {
  const ws = actor.workspaceId;
  const reg = await tx.opsEventRegistration.findFirst({ where: { id, workspaceId: ws } });
  if (!reg || (reg.status !== "pending" && reg.status !== "confirmed")) return false;
  if (to === "expired" && reg.status !== "pending") return false;
  const claimed = await tx.opsEventRegistration.updateMany({
    where: { id, workspaceId: ws, status: reg.status },
    data: { status: to, cancelledAt: new Date() },
  });
  if (claimed.count !== 1) return false;
  await tx.opsEventAttendee.updateMany({ where: { workspaceId: ws, registrationId: id }, data: { status: to } });
  const ticket = await tx.opsEventTicketType.findFirstOrThrow({ where: { id: reg.ticketTypeId, workspaceId: ws }, select: { sessionId: true } });
  await releaseSeats(tx, { workspaceId: ws, eventId: reg.eventId, sessionId: ticket.sessionId, ticketTypeId: reg.ticketTypeId, quantity: reg.quantity });
  const paid = reg.status === "confirmed" && reg.amountCents > 0;
  await audit(
    tx,
    actor,
    "event-registrations",
    id,
    to === "expired" ? "expire" : "cancel",
    `${registrationLabel(id)} ${to} (${reason}); ${reg.quantity} seat(s) released${paid ? ` — ${fmtMoney(reg.amountCents, reg.currency)} was paid: refund it in Stripe if owed (ShapesOS never moves money back)` : ""}`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// OPS_ENTITIES hooks (staff + agent)
// ---------------------------------------------------------------------------

export async function createStaffRegistrationRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const ticket = await tx.opsEventTicketType.findFirst({ where: { id: String(body.ticketTypeId), workspaceId: actor.workspaceId }, select: { priceCents: true } });
  if (!ticket) throw new OpsNotFoundError("event-ticket-types", String(body.ticketTypeId));
  if (ticket.priceCents > 0 && body.comp !== true) {
    throw new OpsError(422, "Paid tickets are bought on the public event page (Stripe). Staff can add complimentary seats with comp: true.");
  }
  const out = await registerCore(tx, actor, {
    ticketTypeId: String(body.ticketTypeId),
    quantity: Number(body.quantity ?? 1),
    name: String(body.name),
    email: String(body.email),
    attendees: body.attendees as RegisterInput["attendees"],
    source: actor.userId.startsWith("agent") ? "agent" : "staff",
    comp: body.comp === true,
  });
  return out.registration as unknown as Row;
}

export async function patchRegistrationRow(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  if (patch.status === "cancelled") {
    if (existing.status !== "pending" && existing.status !== "confirmed") throw new OpsError(409, `This registration is already ${String(existing.status)}`);
    if (!(await endRegistration(tx, actor, id, "cancelled", `cancelled by ${actor.userId}`))) throw new OpsError(409, "The registration changed concurrently — reload");
  }
  return (await tx.opsEventRegistration.findFirstOrThrow({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Row;
}

export async function patchAttendeeRow(tx: Tx, actor: OpsActor, id: string, patch: Row): Promise<Row> {
  const data: Row = {};
  if (typeof patch.name === "string") data.name = patch.name;
  if (patch.email !== undefined) {
    if (patch.email === null) data.email = null;
    else {
      const e = normalizeEmail(patch.email);
      if (!e) throw new OpsError(400, "Enter a valid email address");
      data.email = e;
    }
  }
  return (await tx.opsEventAttendee.update({ where: { id, workspaceId: actor.workspaceId }, data })) as unknown as Row;
}

// ---------------------------------------------------------------------------
// Public registration (the /events/<slug> page)
// ---------------------------------------------------------------------------

export interface PublicEventRef {
  id: string;
  workspaceId: string;
  slug: string;
  title: string;
  currency: string;
}

export class EventPaymentsNotConnectedError extends OpsError {
  readonly code = "stripe_not_connected";
  constructor() {
    super(409, "This event can't take payments yet. The organiser needs to connect Stripe in Finance settings.");
    this.name = "EventPaymentsNotConnectedError";
  }
}

export type PublicRegisterResult =
  | { status: "confirmed"; registrationId: string; viewToken: string }
  | { status: "payment_required"; registrationId: string; url: string };

export async function registerPublic(
  event: PublicEventRef,
  input: Omit<RegisterInput, "source" | "comp">,
  opts: { baseUrl: string; stripe?: StripeFactory; now?: Date },
): Promise<PublicRegisterResult> {
  const actor: OpsActor = { workspaceId: event.workspaceId, userId: EVENTS_PUBLIC_ACTOR };
  const now = opts.now ?? new Date();
  const { out, secretKey } = await withWorkspaceScope(event.workspaceId, async (tx) => {
    const t = await tx.opsEventTicketType.findFirst({ where: { id: input.ticketTypeId, workspaceId: event.workspaceId, eventId: event.id }, select: { priceCents: true } });
    if (!t) throw new OpsError(404, "That ticket isn't part of this event");
    let secretKey: string | null = null;
    if (t.priceCents > 0) {
      secretKey = (await tenantKeys(tx, event.workspaceId)).secretKey;
      if (!secretKey) throw new EventPaymentsNotConnectedError();
    }
    const out = await registerCore(tx, actor, { ...input, source: "public", now });
    return { out, secretKey };
  });
  const reg = out.registration;
  const viewToken = signRegistrationView({ workspaceId: event.workspaceId, registrationId: reg.id });
  if (!out.needsPayment) {
    await afterConfirmed(event.workspaceId, reg.id);
    return { status: "confirmed", registrationId: reg.id, viewToken };
  }

  const base = `${opts.baseUrl.replace(/\/+$/, "")}/events/${event.slug}`;
  const metadata = { workspace_id: event.workspaceId, event_registration_id: reg.id, event_id: event.id };
  let session: { id: string; url: string | null };
  try {
    session = await (opts.stripe ?? realStripe)(secretKey!).checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: reg.quantity,
          price_data: { currency: reg.currency.toLowerCase(), unit_amount: reg.unitPriceCents, product_data: { name: `${event.title} — ${out.ticketName}`.slice(0, 250) } },
        },
      ],
      customer_email: reg.email,
      metadata,
      payment_intent_data: { metadata },
      client_reference_id: reg.id,
      success_url: `${base}/registered?k=${encodeURIComponent(viewToken)}`,
      cancel_url: `${base}?cancelled=1`,
      expires_at: Math.floor(now.getTime() / 1000) + EVENT_CHECKOUT_TTL_S,
    });
    if (!session.url) throw new Error("Stripe returned no checkout URL");
  } catch (err) {
    await withWorkspaceScope(event.workspaceId, (tx) => endRegistration(tx, actor, reg.id, "cancelled", `Stripe checkout could not be created: ${(err as Error)?.message ?? "error"}`.slice(0, 300)));
    if (err instanceof OpsError) throw err;
    throw new OpsError(502, "Payment provider unavailable. Try again in a moment.");
  }
  await withWorkspaceScope(event.workspaceId, (tx) =>
    tx.opsEventRegistration.updateMany({ where: { id: reg.id, workspaceId: event.workspaceId, status: "pending" }, data: { stripeSessionId: session.id } }),
  );
  return { status: "payment_required", registrationId: reg.id, url: session.url! };
}

/** Post-commit side effects of a confirmation (reminders), best-effort. */
export async function afterConfirmed(workspaceId: string, registrationId: string): Promise<void> {
  try {
    const { enrollRegistrationReminders } = await import("./reminders");
    await enrollRegistrationReminders(workspaceId, registrationId);
  } catch (err) {
    console.error(`[events] reminders for ${registrationId}: ${(err as Error)?.message ?? "error"}`);
  }
}

// ---------------------------------------------------------------------------
// Stripe webhook (called by lib/ops/finance/stripe.ts AFTER the signature
// verified against the workspace's own webhook secret)
// ---------------------------------------------------------------------------

interface CheckoutSessionLike {
  id: string;
  payment_status?: string;
  amount_total?: number | null;
  payment_intent?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
}

export function isEventCheckoutEvent(event: { type: string; data: { object: unknown } }): boolean {
  if (!event.type.startsWith("checkout.session.")) return false;
  const md = (event.data.object as CheckoutSessionLike | null)?.metadata;
  return Boolean(md && typeof md.event_registration_id === "string" && md.event_registration_id);
}

export async function handleEventCheckoutEvent(
  workspaceId: string,
  event: { id: string; type: string; data: { object: unknown } },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const session = event.data.object as CheckoutSessionLike;
  const regId = session.metadata?.event_registration_id;
  if (session.metadata?.workspace_id !== workspaceId || !regId) {
    return { status: 200, body: { received: true, ignored: "not an event registration for this workspace" } };
  }
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (session.payment_status !== "paid" || !session.amount_total) {
        return { status: 200, body: { received: true, ignored: `payment_status ${session.payment_status ?? "unknown"}` } };
      }
      const r = await confirmPaidRegistration(workspaceId, regId, session, event.id);
      if (r.status === "confirmed" && !r.duplicate) await afterConfirmed(workspaceId, regId);
      return { status: 200, body: { received: true, ...r } };
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      const actor: OpsActor = { workspaceId, userId: "stripe-webhook" };
      const ended = await withWorkspaceScope(workspaceId, async (tx) => {
        const reg = await tx.opsEventRegistration.findFirst({ where: { id: regId, workspaceId }, select: { status: true, stripeSessionId: true } });
        if (!reg || reg.status !== "pending" || reg.stripeSessionId !== session.id) return false;
        return endRegistration(tx, actor, regId, "expired", event.type.replace("checkout.session.", "checkout "));
      });
      return { status: 200, body: { received: true, registrationId: regId, expired: ended } };
    }
    default:
      return { status: 200, body: { received: true, ignored: event.type } };
  }
}

function intentId(pi: CheckoutSessionLike["payment_intent"]): string | null {
  if (!pi) return null;
  return typeof pi === "string" ? pi : pi.id ?? null;
}

export async function confirmPaidRegistration(
  workspaceId: string,
  regId: string,
  session: CheckoutSessionLike,
  eventId: string,
): Promise<Record<string, unknown> & { status?: string; duplicate?: boolean }> {
  const providerRef = intentId(session.payment_intent) ?? session.id;
  const actor: OpsActor = { workspaceId, userId: "stripe-webhook" };
  const amount = session.amount_total!;
  return withWorkspaceScope(workspaceId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stripe:${workspaceId}:${providerRef}`}))`;
    const prior = await tx.opsPayment.findFirst({ where: { workspaceId, provider: "stripe", providerRef } });
    if (prior) return { duplicate: true, paymentId: prior.id, registrationId: regId };
    const reg = await tx.opsEventRegistration.findFirst({ where: { id: regId, workspaceId } });
    const fits = reg && reg.status === "pending" && reg.stripeSessionId === session.id && reg.amountCents === amount;
    if (!reg || !fits) {
      // Money arrived for a hold that is gone (expired, cancelled) or a
      // different amount: never applied automatically — a person decides
      // (re-seat the buyer, or refund in Stripe).
      await audit(
        tx,
        actor,
        "event-registrations",
        regId,
        "stripe_payment_unapplied",
        `Stripe payment ${providerRef} (${amount}c, session ${session.id}) could not be applied automatically (registration ${reg?.status ?? "missing"}, amount ${reg?.amountCents ?? 0}c) — reconcile by hand`,
      );
      return { duplicate: false, unapplied: true, registrationId: regId };
    }
    const paidAt = new Date();
    const claimed = await tx.opsEventRegistration.updateMany({
      where: { id: regId, workspaceId, status: "pending", stripeSessionId: session.id },
      data: { status: "confirmed", paidAt, confirmedAt: paidAt, paymentRef: providerRef, expiresAt: null },
    });
    if (claimed.count !== 1) return { duplicate: true, registrationId: regId };
    await tx.opsEventAttendee.updateMany({ where: { workspaceId, registrationId: regId }, data: { status: "confirmed" } });
    const payment = await tx.opsPayment.create({
      data: {
        workspaceId,
        kind: "charge",
        provider: "stripe",
        providerRef,
        amountCents: amount,
        status: "succeeded",
        note: `Event registration ${registrationLabel(regId)} — Stripe Checkout ${session.id} (event ${eventId})`,
      },
    });
    const posted = await postEventTicketSale(tx, actor, { id: regId, amountCents: amount, paidAt }, registrationLabel(regId));
    await audit(tx, actor, "event-registrations", regId, "paid", `${registrationLabel(regId)} paid via Stripe (${amount}c, ${providerRef}) → confirmed; journal ${posted?.entry.id ?? "none"}`);
    return { duplicate: false, status: "confirmed", registrationId: regId, paymentId: payment.id, journalEntryId: posted?.entry.id ?? null };
  });
}
