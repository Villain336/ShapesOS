// ShapesOS — Phase 12 (people): events on real Postgres, as the
// least-privilege app role.
//   - only PUBLISHED events resolve publicly (SELECT-only routing policy)
//   - free registration → confirmed attendees linked to an OpsContact,
//     matched by email on the next registration
//   - a PAID registration is pending (seats held) until the Stripe-signed
//     webhook: then confirmed + OpsPayment + balanced journal entry, once;
//     redelivery changes nothing; expiry releases the seats; no tenant
//     Stripe key → refused with nothing reserved
//   - capacity under concurrency: 12 simultaneous registrations for 5 seats
//     → exactly 5 succeed; the DB CHECK refuses a raw oversell
//   - check-in is once-only (also for two simultaneous scans); pending,
//     cancelled, forged and other-workspace tickets are refused
//   - staff registrations: free or comp only; reminders enroll the
//     registrant in the event's nurture sequence once
//   - FORCE RLS on all five event tables
// Stripe: the real SDK signs/verifies webhook payloads offline; Checkout
// Session creation is a labelled STUB (no network, no live Stripe account).
// Run (DB suite): DATABASE_URL=<app role url> MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/ops/__tests__/p12-events-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, opsList, opsPatch, type OpsActor } from "../doctype";
import { handleStripeWebhook, saveFinanceSettings, type StripeFactory, type StripeLike } from "../finance/stripe";
import { findEntryBySource } from "../accounting";
import { resolvePublishedEvent, loadPublicEvent, loadRegistrationView, type PublicEvent } from "../events/catalog";
import { EventPaymentsNotConnectedError, registerCore, registerPublic } from "../events/registrations";
import { SoldOutError } from "../events/capacity";
import { checkInAttendee } from "../events/checkin";
import { signTicket, verifyRegistrationView } from "../events/tickets";
import { eventsOverviewCore, eventsRegisterCore } from "@/lib/chat/ops-people-tools";

process.env.AUTH_SECRET ??= "p12-events-db-test-secret-0123456789abcdef";

const WS_A = "p12evt-ws-a";
const WS_B = "p12evt-ws-b";
const A: OpsActor = { workspaceId: WS_A, userId: "user-p12evt-a" };
const B: OpsActor = { workspaceId: WS_B, userId: "user-p12evt-b" };
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const rowOf = (r: unknown) => (r as { row: Record<string, unknown> }).row;
const SECRET_KEY = "sk_test_51Hp12eventsabcdefghij";
const WHSEC = "whsec_p12eventstestsecret123";
const BASE = "https://app.example.test";

const sdk = new Stripe(SECRET_KEY);
// STUB (labelled): Checkout Session creation never reaches Stripe.
const created: Array<Record<string, unknown>> = [];
let seq = 0;
const stubStripe: StripeFactory = () =>
  ({
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          created.push(params);
          seq += 1;
          return { id: `cs_test_p12evt_${seq}`, url: `https://checkout.stripe.test/p12/${seq}` };
        },
      },
    },
    webhooks: sdk.webhooks,
  }) as unknown as StripeLike;
const realVerify: StripeFactory = () => sdk as never;

async function ws(id: string) {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now())`;
}
const create = async (actor: OpsActor, slug: string, body: Record<string, unknown>) => rowOf(await withWorkspaceScope(actor.workspaceId, (tx) => opsCreate(tx, def(slug), actor, body)));
const patch = (actor: OpsActor, slug: string, body: Record<string, unknown>) => withWorkspaceScope(actor.workspaceId, (tx) => opsPatch(tx, def(slug), actor, body));
const ticketRow = (id: string) => withWorkspaceScope(WS_A, (tx) => tx.opsEventTicketType.findFirstOrThrow({ where: { id, workspaceId: WS_A } }));
const eventRow = (id: string) => withWorkspaceScope(WS_A, (tx) => tx.opsEvent.findFirstOrThrow({ where: { id, workspaceId: WS_A } }));
const regRow = (id: string) => withWorkspaceScope(WS_A, (tx) => tx.opsEventRegistration.findFirstOrThrow({ where: { id, workspaceId: WS_A }, include: { attendees: true } }));

function stripeEvent(id: string, type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  return { payload, header: sdk.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) };
}

const ids = { event: "", free: "", paid: "", tiny: "", eventB: "", seq: "", pipeline: "" };
let pub: PublicEvent;
const future = (days: number, h = 17) => new Date(Date.UTC(2030, 0, 1 + days, h)).toISOString();

before(async () => {
  await ws(WS_A);
  await ws(WS_B);
  // Reminders reuse the nurture engine: a pipeline for the lead + a sequence.
  ids.pipeline = (await prisma.pipeline.create({ data: { workspaceId: WS_A, name: "Sales", isDefault: true, stages: [{ id: "new", label: "New" }] } })).id;
  ids.seq = (await prisma.nurtureSequence.create({ data: { workspaceId: WS_A, name: "Event reminders", status: "active", steps: [{ channel: "email", delayMinutes: 60, subject: "See you soon", template: "Hi {{firstName}}" }] } })).id;

  const ev = await create(A, "events", { title: "P12 Launch Night", startsAt: future(10), endsAt: future(10, 21), venue: "Hall 1", webinarUrl: "https://meet.example.test/launch", capacity: 40, reminderSequenceId: ids.seq });
  ids.event = String(ev.id);
  assert.equal(ev.slug, "p12-launch-night");
  ids.free = String((await create(A, "event-ticket-types", { eventId: ids.event, name: "Free", priceCents: 0 })).id);
  ids.paid = String((await create(A, "event-ticket-types", { eventId: ids.event, name: "VIP", priceCents: 2_500, quantity: 20, maxPerOrder: 4 })).id);
  ids.tiny = String((await create(A, "event-ticket-types", { eventId: ids.event, name: "Workshop", priceCents: 0, quantity: 5, maxPerOrder: 1 })).id);
  await withWorkspaceScope(WS_A, (tx) => saveFinanceSettings(tx, A, { stripeSecretKey: SECRET_KEY, stripeWebhookSecret: WHSEC }));

  // Workspace B: its own published event, no Stripe.
  const evB = await create(B, "events", { title: "B Paid Meetup", startsAt: future(12), endsAt: future(12, 21) });
  ids.eventB = String(evB.id);
  await create(B, "event-ticket-types", { eventId: ids.eventB, name: "Paid", priceCents: 1_000 });
  await patch(B, "events", { id: ids.eventB, status: "published" });
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS_A}`;
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS_B}`;
  await prisma.$disconnect();
});

describe("publishing and visibility", () => {
  it("drafts are invisible; publishing needs a ticket type; slugs are global", async () => {
    assert.equal(await resolvePublishedEvent("p12-launch-night"), null, "draft → not found");
    const bare = await create(A, "events", { title: "No tickets yet", startsAt: future(5), endsAt: future(5, 20) });
    await assert.rejects(patch(A, "events", { id: bare.id, status: "published" }), /ticket type/);
    await assert.rejects(create(B, "events", { title: "x", slug: "p12-launch-night", startsAt: future(5), endsAt: future(5, 20) }), (e: unknown) => e instanceof OpsError && e.status === 409);
    const dup = await create(B, "events", { title: "P12 Launch Night", startsAt: future(5), endsAt: future(5, 20) });
    assert.match(String(dup.slug), /^p12-launch-night-[0-9a-f]{6}$/, "derived slug gets a suffix");
    await patch(A, "events", { id: ids.event, status: "published" });
    pub = (await resolvePublishedEvent("p12-launch-night"))!;
    assert.equal(pub.workspaceId, WS_A);
    assert.equal(pub.hasWebinar, true);
    assert.ok(!("webinarUrl" in pub), "the webinar link never reaches the public page");
    const { tickets, paymentsReady } = await loadPublicEvent(pub);
    assert.equal(tickets.length, 3);
    assert.equal(paymentsReady, true);
    assert.equal(await prisma.opsEvent.count(), 0, "no GUC: RLS hides every event");
  });
});

describe("registration", () => {
  let freeReg = "";

  it("free → confirmed at once, attendees linked to a matched-or-created contact", async () => {
    const r = await registerPublic(pub, { ticketTypeId: ids.free, quantity: 2, name: "Ada Lovelace", email: "Ada@Example.test", attendees: [{ name: "Ada Lovelace" }, { name: "Charles B", email: "charles@example.test" }] }, { baseUrl: BASE, stripe: stubStripe });
    assert.equal(r.status, "confirmed");
    freeReg = r.registrationId;
    const reg = await regRow(freeReg);
    assert.equal(reg.status, "confirmed");
    assert.equal(reg.email, "ada@example.test");
    assert.equal(reg.attendees.length, 2);
    assert.ok(reg.attendees.every((a) => a.status === "confirmed"));
    const contacts = await withWorkspaceScope(WS_A, (tx) => tx.opsContact.findMany({ where: { workspaceId: WS_A }, orderBy: { email: "asc" } }));
    assert.deepEqual(contacts.map((c) => c.email), ["ada@example.test", "charles@example.test"]);
    assert.equal(reg.contactId, contacts[0]!.id);
    // A second registration by the same email reuses the contact.
    const again = await registerPublic(pub, { ticketTypeId: ids.free, quantity: 1, name: "Ada L.", email: "ada@example.test" }, { baseUrl: BASE });
    assert.equal((await regRow(again.registrationId)).contactId, contacts[0]!.id);
    assert.equal(await withWorkspaceScope(WS_A, (tx) => tx.opsContact.count({ where: { workspaceId: WS_A } })), 2);
    assert.equal((await eventRow(ids.event)).reservedCount, 3);
  });

  it("confirmed registrants are enrolled in the reminder sequence once (nurture engine)", async () => {
    const reg = await regRow(freeReg);
    assert.ok(reg.remindersEnrolledAt, "enrolled after confirmation");
    const lead = await prisma.lead.findFirstOrThrow({ where: { workspaceId: WS_A, dedupKey: "email:ada@example.test" } });
    const enrollments = await prisma.sequenceEnrollment.findMany({ where: { workspaceId: WS_A, sequenceId: ids.seq, leadId: lead.id } });
    assert.equal(enrollments.length, 1, "the second registration by the same person reuses the enrollment");
  });

  it("the registration view token shows the QR tickets and the webinar link", async () => {
    const r = await registerPublic(pub, { ticketTypeId: ids.free, quantity: 1, name: "Grace", email: "grace@example.test" }, { baseUrl: BASE });
    assert.equal(r.status, "confirmed");
    const token = (r as { viewToken: string }).viewToken;
    assert.deepEqual(verifyRegistrationView(token), { workspaceId: WS_A, registrationId: r.registrationId });
    const view = await loadRegistrationView(token, BASE);
    assert.equal(view!.event.webinarUrl, "https://meet.example.test/launch");
    assert.equal(view!.tickets.length, 1);
    assert.match(view!.tickets[0]!.qrDataUrl!, /^data:image\/png;base64,/);
    assert.match(view!.tickets[0]!.url!, /^https:\/\/app\.example\.test\/events\/ticket\/t1\./);
  });

  it("paid → pending with seats held until the signed webhook; once only; journal balanced", async () => {
    const before = await ticketRow(ids.paid);
    const r = await registerPublic(pub, { ticketTypeId: ids.paid, quantity: 2, name: "Vic Paid", email: "vic@example.test" }, { baseUrl: BASE, stripe: stubStripe });
    assert.equal(r.status, "payment_required");
    const params = created.at(-1)!;
    const md = params.metadata as Record<string, string>;
    assert.equal(md.event_registration_id, r.registrationId);
    assert.equal(md.workspace_id, WS_A);
    assert.equal((params.line_items as Array<{ quantity: number; price_data: { unit_amount: number } }>)[0]!.price_data.unit_amount, 2_500);
    const pending = await regRow(r.registrationId);
    assert.equal(pending.status, "pending");
    assert.equal(pending.amountCents, 5_000);
    assert.ok(pending.attendees.every((a) => a.status === "pending"));
    assert.equal((await ticketRow(ids.paid)).soldCount, before.soldCount + 2, "seats held while paying");

    // A pending attendee can't check in.
    const tokenOf = (a: { id: string; ticketCode: string }) => signTicket({ workspaceId: WS_A, eventId: ids.event, attendeeId: a.id, ticketCode: a.ticketCode });
    const ci = await withWorkspaceScope(WS_A, (tx) => checkInAttendee(tx, A, tokenOf(pending.attendees[0]!)));
    assert.equal(ci.status, "not_confirmed");

    const session = { id: pending.stripeSessionId, object: "checkout.session", payment_status: "paid", amount_total: 5_000, payment_intent: "pi_p12evt_1", metadata: md };
    const e1 = stripeEvent("evt_p12evt_1", "checkout.session.completed", session);
    const out = await handleStripeWebhook(WS_A, e1.payload, e1.header, { stripe: realVerify });
    assert.equal(out.status, 200);
    assert.equal(out.body.status, "confirmed");
    const paid = await regRow(r.registrationId);
    assert.equal(paid.status, "confirmed");
    assert.equal(paid.paymentRef, "pi_p12evt_1");
    assert.ok(paid.attendees.every((a) => a.status === "confirmed"));
    const payments = await withWorkspaceScope(WS_A, (tx) => tx.opsPayment.findMany({ where: { workspaceId: WS_A, providerRef: "pi_p12evt_1" } }));
    assert.equal(payments.length, 1);
    const entry = await withWorkspaceScope(WS_A, (tx) => findEntryBySource(tx, WS_A, `event_registration:${r.registrationId}:paid`));
    const by = Object.fromEntries(entry!.lines.map((l) => [l.accountCode, l.debitCents || -l.creditCents]));
    assert.deepEqual(by, { "1000": 5_000, "4000": -5_000 });

    // Redelivery (same event, or a new event id for the same payment) is a no-op.
    for (const ev of [e1, stripeEvent("evt_p12evt_1b", "checkout.session.completed", session)]) {
      const dup = await handleStripeWebhook(WS_A, ev.payload, ev.header, { stripe: realVerify });
      assert.equal(dup.body.duplicate, true);
    }
    assert.equal(await withWorkspaceScope(WS_A, (tx) => tx.opsPayment.count({ where: { workspaceId: WS_A, providerRef: "pi_p12evt_1" } })), 1);
    assert.equal((await ticketRow(ids.paid)).soldCount, before.soldCount + 2);
    // A forged signature never reaches the handler.
    const bad = await handleStripeWebhook(WS_A, e1.payload, "t=1,v1=deadbeef", { stripe: realVerify });
    assert.equal(bad.status, 400);
  });

  it("an expired checkout releases the seats; a late payment for it is flagged, not applied", async () => {
    const before = await ticketRow(ids.paid);
    const r = await registerPublic(pub, { ticketTypeId: ids.paid, quantity: 3, name: "Lapsed", email: "lapsed@example.test" }, { baseUrl: BASE, stripe: stubStripe });
    const reg = await regRow(r.registrationId);
    const md = { workspace_id: WS_A, event_registration_id: r.registrationId, event_id: ids.event };
    const exp = stripeEvent("evt_p12evt_exp", "checkout.session.expired", { id: reg.stripeSessionId, object: "checkout.session", metadata: md });
    const out = await handleStripeWebhook(WS_A, exp.payload, exp.header, { stripe: realVerify });
    assert.equal(out.body.expired, true);
    assert.equal((await regRow(r.registrationId)).status, "expired");
    assert.equal((await ticketRow(ids.paid)).soldCount, before.soldCount, "seats released");
    const late = stripeEvent("evt_p12evt_late", "checkout.session.completed", { id: reg.stripeSessionId, object: "checkout.session", payment_status: "paid", amount_total: 7_500, payment_intent: "pi_p12evt_late", metadata: md });
    const lateOut = await handleStripeWebhook(WS_A, late.payload, late.header, { stripe: realVerify });
    assert.equal(lateOut.body.unapplied, true);
    assert.equal((await regRow(r.registrationId)).status, "expired");
  });

  it("no tenant Stripe key → paid registration refused, nothing reserved", async () => {
    const evB = (await resolvePublishedEvent((await withWorkspaceScope(WS_B, (tx) => tx.opsEvent.findFirstOrThrow({ where: { id: ids.eventB, workspaceId: WS_B } }))).slug))!;
    const tB = await withWorkspaceScope(WS_B, (tx) => tx.opsEventTicketType.findFirstOrThrow({ where: { workspaceId: WS_B, eventId: ids.eventB } }));
    await assert.rejects(registerPublic(evB, { ticketTypeId: tB.id, quantity: 1, name: "X", email: "x@example.test" }, { baseUrl: BASE, stripe: stubStripe }), EventPaymentsNotConnectedError);
    assert.equal(await withWorkspaceScope(WS_B, (tx) => tx.opsEventRegistration.count({ where: { workspaceId: WS_B } })), 0);
    assert.equal((await withWorkspaceScope(WS_B, (tx) => tx.opsEventTicketType.findFirstOrThrow({ where: { id: tB.id, workspaceId: WS_B } }))).soldCount, 0);
    // A ticket of another event (another workspace) is never sold through this page.
    await assert.rejects(registerPublic(pub, { ticketTypeId: tB.id, quantity: 1, name: "X", email: "x@example.test" }, { baseUrl: BASE }), /isn't part of this event/);
  });
});

describe("capacity under concurrency", () => {
  it("12 simultaneous registrations for 5 seats → exactly 5 succeed", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        withWorkspaceScope(WS_A, (tx) => registerCore(tx, { workspaceId: WS_A, userId: "event-registration" }, { ticketTypeId: ids.tiny, quantity: 1, name: `Racer ${i}`, email: `racer${i}@example.test`, source: "public" })),
      ),
    );
    const ok = attempts.filter((a) => a.status === "fulfilled").length;
    const soldOut = attempts.filter((a) => a.status === "rejected" && a.reason instanceof SoldOutError).length;
    assert.equal(ok, 5);
    assert.equal(soldOut, 7, `others are sold out: ${attempts.filter((a) => a.status === "rejected" && !(a.reason instanceof SoldOutError)).map((a) => String((a as PromiseRejectedResult).reason)).join("; ")}`);
    const t = await ticketRow(ids.tiny);
    assert.equal(t.soldCount, 5);
    assert.equal(await withWorkspaceScope(WS_A, (tx) => tx.opsEventRegistration.count({ where: { workspaceId: WS_A, ticketTypeId: ids.tiny, status: "confirmed" } })), 5);
  });

  it("the database refuses an oversell even outside the service", async () => {
    await assert.rejects(withWorkspaceScope(WS_A, (tx) => tx.$executeRawUnsafe(`UPDATE ops_event_ticket_types SET sold_count = quantity + 1 WHERE id = $1`, ids.tiny)), /ops_event_ticket_types_chk|check/i);
    await assert.rejects(withWorkspaceScope(WS_A, (tx) => tx.$executeRawUnsafe(`UPDATE ops_events SET reserved_count = capacity + 1 WHERE id = $1`, ids.event)), /ops_events_capacity_chk|check/i);
    await assert.rejects(patch(A, "event-ticket-types", { id: ids.tiny, quantity: 4 }), /already taken/);
  });

  it("the event's own capacity caps every ticket type", async () => {
    const e = await eventRow(ids.event);
    const left = e.capacity! - e.reservedCount;
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) => registerCore(tx, A, { ticketTypeId: ids.free, quantity: left + 1, name: "Crowd", email: "crowd@example.test", source: "staff" })),
      (err: unknown) => err instanceof OpsError && err.status >= 400,
    );
    assert.equal((await eventRow(ids.event)).reservedCount, e.reservedCount, "nothing taken");
  });
});

describe("check-in", () => {
  it("once per attendee — also for two simultaneous scans", async () => {
    const r = await registerPublic(pub, { ticketTypeId: ids.free, quantity: 2, name: "Door Test", email: "door@example.test" }, { baseUrl: BASE });
    const reg = await regRow(r.registrationId);
    const [a1, a2] = reg.attendees;
    const tok = (a: { id: string; ticketCode: string }) => `${BASE}/events/ticket/${signTicket({ workspaceId: WS_A, eventId: ids.event, attendeeId: a.id, ticketCode: a.ticketCode })}`;
    const first = await withWorkspaceScope(WS_A, (tx) => checkInAttendee(tx, A, tok(a1!), { eventId: ids.event }));
    assert.equal(first.status, "checked_in");
    const second = await withWorkspaceScope(WS_A, (tx) => checkInAttendee(tx, A, tok(a1!), { eventId: ids.event }));
    assert.equal(second.status, "already_checked_in");
    assert.match(second.message, /Already checked in/);
    const both = await Promise.all([0, 1].map(() => withWorkspaceScope(WS_A, (tx) => checkInAttendee(tx, A, tok(a2!)))));
    assert.deepEqual(both.map((b) => b.status).sort(), ["already_checked_in", "checked_in"]);
    const audits = await withWorkspaceScope(WS_A, (tx) => tx.opsAuditEvent.count({ where: { workspaceId: WS_A, entity: "event-attendees", action: "check_in", entityId: { in: [a1!.id, a2!.id] } } }));
    assert.equal(audits, 2);
  });

  it("refuses forged, foreign, wrong-event and cancelled tickets", async () => {
    const r = await registerPublic(pub, { ticketTypeId: ids.free, quantity: 1, name: "To Cancel", email: "cancel@example.test" }, { baseUrl: BASE });
    const reg = await regRow(r.registrationId);
    const a = reg.attendees[0]!;
    const token = signTicket({ workspaceId: WS_A, eventId: ids.event, attendeeId: a.id, ticketCode: a.ticketCode });
    assert.equal((await withWorkspaceScope(WS_A, (tx) => checkInAttendee(tx, A, token.slice(0, -3) + "abc"))).status, "invalid");
    assert.equal((await withWorkspaceScope(WS_B, (tx) => checkInAttendee(tx, B, token))).status, "invalid", "another workspace's staff can't use it");
    assert.equal((await withWorkspaceScope(WS_A, (tx) => checkInAttendee(tx, A, token, { eventId: "ev_other" }))).status, "invalid");
    const wrongCode = signTicket({ workspaceId: WS_A, eventId: ids.event, attendeeId: a.id, ticketCode: "AAAAAAAAAAAAAAAAAAAAAA" });
    assert.equal((await withWorkspaceScope(WS_A, (tx) => checkInAttendee(tx, A, wrongCode))).status, "invalid");
    const before = (await eventRow(ids.event)).reservedCount;
    await patch(A, "event-registrations", { id: r.registrationId, status: "cancelled" });
    assert.equal((await eventRow(ids.event)).reservedCount, before - 1, "cancel releases the seat");
    assert.equal((await withWorkspaceScope(WS_A, (tx) => checkInAttendee(tx, A, token))).status, "not_confirmed");
    await assert.rejects(patch(A, "event-registrations", { id: r.registrationId, status: "cancelled" }), /already cancelled/);
  });
});

describe("staff + agent registrations", () => {
  it("free or comp only; the agent tool registers through the same core", async () => {
    await assert.rejects(create(A, "event-registrations", { ticketTypeId: ids.paid, name: "Comp?", email: "comp@example.test" }), (e: unknown) => e instanceof OpsError && e.status === 422);
    const comp = await create(A, "event-registrations", { ticketTypeId: ids.paid, name: "Speaker", email: "speaker@example.test", comp: true, quantity: 2 });
    assert.equal(comp.status, "confirmed");
    assert.equal(comp.amountCents, 0);
    assert.equal(comp.source, "staff");
    const tool = await withWorkspaceScope(WS_A, (tx) => eventsRegisterCore(tx, { workspaceId: WS_A, userId: "agent:chat" }, { ticketTypeId: ids.free, name: "Agent Guest", email: "agentguest@example.test" }));
    assert.equal((tool.details as { status: string }).status, "confirmed");
    const ov = await withWorkspaceScope(WS_A, (tx) => eventsOverviewCore(tx, A));
    assert.match(ov.summary, /P12 Launch Night/);
    await assert.rejects(create(A, "event-attendees", { registrationId: "x" }), (e: unknown) => e instanceof OpsError && e.status === 405);
  });
});

describe("events RLS", () => {
  it("another workspace sees none of A's event rows; no GUC sees nothing", async () => {
    for (const slug of ["events", "event-sessions", "event-ticket-types", "event-registrations", "event-attendees"]) {
      const theirs = await withWorkspaceScope(WS_B, (tx) => opsList(tx, def(slug), B, { limit: 200 }));
      assert.ok(theirs.rows.every((r) => r.workspaceId === WS_B), `${slug}: only B's rows`);
    }
    const mine = await withWorkspaceScope(WS_A, (tx) => opsList(tx, def("event-attendees"), A, { limit: 200 }));
    assert.ok(mine.rows.length > 0);
    assert.equal(await prisma.opsEventAttendee.count(), 0);
    assert.equal(await prisma.opsEventRegistration.count(), 0);
    assert.equal(await prisma.opsEventTicketType.count(), 0);
    assert.equal(await prisma.opsEventSession.count(), 0);
    await assert.rejects(withWorkspaceScope(WS_B, (tx) => tx.opsEventTicketType.updateMany({ where: { id: ids.free }, data: { soldCount: 0 } }).then((r) => { if (r.count === 0) throw new Error("not visible"); })), /not visible/);
    // The public routing policy is SELECT-only and published-only.
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.event_route = 'lookup'`);
        const n = await tx.$executeRawUnsafe(`UPDATE ops_events SET title = 'pwned' WHERE id = $1`, ids.event);
        if (n === 0) throw new Error("read-only");
      }),
      /read-only/,
    );
  });
});
