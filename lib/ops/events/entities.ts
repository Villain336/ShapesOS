// ShapesOS — Phase 12 (people): the events entities on the Ops DocType
// convention (spread into OPS_ENTITIES): the generic /api/ops/{entity}
// route, workspace scoping and audit apply by construction; the rules live
// in lazy-imported hooks (lib/ops/events/admin.ts, registrations.ts).
//
// Capacity counters (reservedCount / soldCount) are NEVER patchable: they
// move only through the row-locked reservation in lib/ops/events/capacity.ts.
// Check-in is POST /api/ops/events/check-in (once per attendee), and paid
// registrations are confirmed only by the tenant's signed Stripe webhook.
//
// PURE: zod only.

import { z } from "zod";
import type { OpsEntityDef } from "../entities";

const MAX_CENTS = 2_147_483_647;
const id = z.string().min(1).max(64);
const isoDate = z
  .string()
  .max(64)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "must be an ISO-8601 date" });
const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((u) => /^https:\/\//i.test(u), { message: "must be an https:// link" });
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/, "use lowercase letters, digits and hyphens");
const capacity = z.number().int().min(0).max(1_000_000);

const lazyAdmin = () => import("./admin");
const lazyReg = () => import("./registrations");

export const eventDef: OpsEntityDef = {
  slug: "events",
  label: "Event",
  delegate: "opsEvent",
  createSchema: z.object({
    title: z.string().trim().min(1).max(200),
    slug: slug.optional(),
    description: z.string().max(20_000).optional(),
    venue: z.string().trim().max(500).optional(),
    webinarUrl: httpsUrl.optional(),
    timezone: z.string().trim().max(64).optional(),
    startsAt: isoDate,
    endsAt: isoDate,
    capacity: capacity.optional(),
    currency: z.string().trim().toUpperCase().length(3).optional(),
    reminderSequenceId: id.optional(),
  }),
  patchSchema: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      slug: slug.optional(),
      description: z.string().max(20_000).nullable().optional(),
      venue: z.string().trim().max(500).nullable().optional(),
      webinarUrl: httpsUrl.nullable().optional(),
      timezone: z.string().trim().max(64).optional(),
      startsAt: isoDate.optional(),
      endsAt: isoDate.optional(),
      capacity: capacity.nullable().optional(),
      currency: z.string().trim().toUpperCase().length(3).optional(),
      reminderSequenceId: id.nullable().optional(),
      status: z.enum(["draft", "published", "cancelled"]).optional(),
    })
    .strict(),
  patchable: true,
  filterable: ["status"],
  gatedTransitions: [],
  summarize: (r) => `event "${r.title}" /events/${r.slug ?? "?"} → ${r.status ?? "draft"}`,
  hooks: {
    create: async (tx, a, b) => (await lazyAdmin()).createEventRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await lazyAdmin()).patchEventRow(tx, a, i, p, e),
  },
};

export const eventSessionDef: OpsEntityDef = {
  slug: "event-sessions",
  label: "Event session",
  delegate: "opsEventSession",
  createSchema: z.object({
    eventId: id,
    title: z.string().trim().min(1).max(200),
    venue: z.string().trim().max(500).optional(),
    webinarUrl: httpsUrl.optional(),
    startsAt: isoDate,
    endsAt: isoDate,
    capacity: capacity.optional(),
    position: z.number().int().min(0).max(10_000).default(0),
  }),
  patchSchema: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      venue: z.string().trim().max(500).nullable().optional(),
      webinarUrl: httpsUrl.nullable().optional(),
      startsAt: isoDate.optional(),
      endsAt: isoDate.optional(),
      capacity: capacity.nullable().optional(),
      position: z.number().int().min(0).max(10_000).optional(),
    })
    .strict(),
  patchable: true,
  filterable: ["eventId"],
  gatedTransitions: [],
  summarize: (r) => `session "${r.title}" of event ${r.eventId}`,
  hooks: {
    create: async (tx, a, b) => (await lazyAdmin()).createSessionRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await lazyAdmin()).patchSessionRow(tx, a, i, p, e),
  },
};

export const eventTicketTypeDef: OpsEntityDef = {
  slug: "event-ticket-types",
  label: "Ticket type",
  delegate: "opsEventTicketType",
  createSchema: z.object({
    eventId: id,
    sessionId: id.optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    priceCents: z.number().int().min(0).max(MAX_CENTS).default(0),
    quantity: capacity.optional(),
    salesStartAt: isoDate.optional(),
    salesEndAt: isoDate.optional(),
    maxPerOrder: z.number().int().min(1).max(100).default(10),
    active: z.boolean().default(true),
    position: z.number().int().min(0).max(10_000).default(0),
  }),
  patchSchema: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(2000).nullable().optional(),
      // Registrations keep the price they paid; a change applies to new ones.
      priceCents: z.number().int().min(0).max(MAX_CENTS).optional(),
      quantity: capacity.nullable().optional(),
      salesStartAt: isoDate.nullable().optional(),
      salesEndAt: isoDate.nullable().optional(),
      maxPerOrder: z.number().int().min(1).max(100).optional(),
      active: z.boolean().optional(),
      position: z.number().int().min(0).max(10_000).optional(),
    })
    .strict(),
  patchable: true,
  filterable: ["eventId", "sessionId"],
  gatedTransitions: [],
  summarize: (r) => `ticket "${r.name}" ${Number(r.priceCents ?? 0) > 0 ? `${r.priceCents}c` : "free"} for event ${r.eventId}`,
  hooks: {
    create: async (tx, a, b) => (await lazyAdmin()).createTicketTypeRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await lazyAdmin()).patchTicketTypeRow(tx, a, i, p, e),
  },
};

export const eventRegistrationDef: OpsEntityDef = {
  slug: "event-registrations",
  label: "Event registration",
  delegate: "opsEventRegistration",
  // Staff / agent registrations: free tickets, or "comp" (complimentary)
  // seats on a paid ticket. Paid seats are bought on the public page.
  createSchema: z.object({
    ticketTypeId: id,
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
    quantity: z.number().int().min(1).max(100).default(1),
    comp: z.boolean().default(false),
    attendees: z
      .array(z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(320).optional() }))
      .max(100)
      .optional(),
  }),
  // Cancelling releases the seats (a paid registration's refund is issued
  // in Stripe by a person — ShapesOS never moves the money back).
  patchSchema: z.object({ status: z.enum(["cancelled"]) }).strict(),
  patchable: true,
  filterable: ["eventId", "status", "ticketTypeId", "contactId"],
  gatedTransitions: [],
  summarize: (r) => `registration ${r.id ?? "(new)"} ${r.email ?? ""} × ${r.quantity ?? 1} → ${r.status ?? "pending"}`,
  hooks: {
    create: async (tx, a, b) => (await lazyReg()).createStaffRegistrationRow(tx, a, b),
    patch: async (tx, a, i, p, e) => (await lazyReg()).patchRegistrationRow(tx, a, i, p, e),
  },
};

export const eventAttendeeDef: OpsEntityDef = {
  slug: "event-attendees",
  label: "Event attendee",
  delegate: "opsEventAttendee",
  createSchema: z.object({ registrationId: id }).strict(),
  // Name/email corrections only; check-in has its own once-only endpoint.
  patchSchema: z
    .object({ name: z.string().trim().min(1).max(200).optional(), email: z.string().trim().email().max(320).nullable().optional() })
    .strict(),
  patchable: true,
  filterable: ["eventId", "registrationId", "status", "contactId"],
  gatedTransitions: [],
  summarize: (r) => `attendee "${r.name}" of event ${r.eventId}${r.checkedInAt ? " (checked in)" : ""}`,
  hooks: {
    create: async () => {
      const { OpsError } = await import("../doctype");
      throw new OpsError(405, "Attendees are created by registering (POST /api/ops/event-registrations or the public event page)");
    },
    patch: async (tx, a, i, p) => (await lazyReg()).patchAttendeeRow(tx, a, i, p),
  },
};

export const EVENT_ENTITIES: OpsEntityDef[] = [eventDef, eventSessionDef, eventTicketTypeDef, eventRegistrationDef, eventAttendeeDef];
