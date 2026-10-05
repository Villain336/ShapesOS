// ShapesOS — Phase 12 (people): what the public event pages read.
//
// resolvePublishedEvent  slug → event, through the ONE SELECT-only routing
//                        policy on ops_events (app.event_route = 'lookup';
//                        published rows only). Unknown / draft → null.
// loadPublicEvent        everything else runs under the tenant GUC
//                        (withWorkspaceScope): sessions and active ticket
//                        types with their live availability.
// loadRegistrationView   a registrant's own registration (signed view
//                        token) and, once confirmed, its QR tickets.
// The webinar link is only shown on confirmed tickets, never on the
// public page.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { EVENT_SLUG_RE, ticketAvailability, type TicketAvailability } from "./pricing";
import { renderTicketQr, sameTicketCode, signTicket, ticketUrl, verifyRegistrationView, verifyTicket } from "./tickets";

export interface PublicEvent {
  id: string;
  workspaceId: string;
  slug: string;
  title: string;
  description: string | null;
  venue: string | null;
  hasWebinar: boolean;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  currency: string;
  status: string;
  capacity: number | null;
  reservedCount: number;
}

const EVENT_SELECT = {
  id: true,
  workspaceId: true,
  slug: true,
  title: true,
  description: true,
  venue: true,
  webinarUrl: true,
  timezone: true,
  startsAt: true,
  endsAt: true,
  currency: true,
  status: true,
  capacity: true,
  reservedCount: true,
} as const;

/** Published event by slug (the routing policy hides everything else). */
export async function resolvePublishedEvent(slug: string): Promise<PublicEvent | null> {
  if (typeof slug !== "string" || !EVENT_SLUG_RE.test(slug)) return null;
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.event_route = 'lookup'`);
    return tx.opsEvent.findFirst({ where: { slug, status: "published" }, select: EVENT_SELECT });
  });
  if (!row) return null;
  const { webinarUrl, ...rest } = row;
  return { ...rest, hasWebinar: Boolean(webinarUrl) };
}

export interface PublicTicket {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  sessionId: string | null;
  sessionTitle: string | null;
  maxPerOrder: number;
  availability: TicketAvailability;
}

export interface PublicSession {
  id: string;
  title: string;
  venue: string | null;
  startsAt: Date;
  endsAt: Date;
}

export async function loadPublicEvent(ev: PublicEvent, now: Date = new Date()): Promise<{ sessions: PublicSession[]; tickets: PublicTicket[]; paymentsReady: boolean }> {
  return withWorkspaceScope(ev.workspaceId, async (tx) => {
    const [sessions, tickets, finance] = await Promise.all([
      tx.opsEventSession.findMany({ where: { workspaceId: ev.workspaceId, eventId: ev.id }, orderBy: [{ startsAt: "asc" }, { position: "asc" }] }),
      tx.opsEventTicketType.findMany({ where: { workspaceId: ev.workspaceId, eventId: ev.id, active: true }, orderBy: [{ position: "asc" }, { priceCents: "asc" }] }),
      tx.opsFinanceSettings.findUnique({ where: { workspaceId: ev.workspaceId }, select: { stripeSecretEnc: true } }),
    ]);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return {
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, venue: s.venue, startsAt: s.startsAt, endsAt: s.endsAt })),
      tickets: tickets.map((t) => {
        const s = t.sessionId ? byId.get(t.sessionId) ?? null : null;
        return {
          id: t.id,
          name: t.name,
          description: t.description,
          priceCents: t.priceCents,
          sessionId: t.sessionId,
          sessionTitle: s?.title ?? null,
          maxPerOrder: t.maxPerOrder,
          availability: ticketAvailability(t, ev, s, now),
        };
      }),
      paymentsReady: Boolean(finance?.stripeSecretEnc),
    };
  });
}

export interface TicketView {
  attendeeId: string;
  name: string;
  status: string;
  checkedInAt: Date | null;
  url: string | null;
  qrDataUrl: string | null;
}

export interface RegistrationView {
  id: string;
  status: string;
  name: string;
  email: string;
  quantity: number;
  amountCents: number;
  currency: string;
  ticketName: string;
  event: { title: string; slug: string; venue: string | null; webinarUrl: string | null; startsAt: Date; endsAt: Date; timezone: string };
  tickets: TicketView[];
}

/** A registrant's own registration by its signed view token (null = invalid). */
export async function loadRegistrationView(token: string, baseUrl: string): Promise<RegistrationView | null> {
  const claims = verifyRegistrationView(token);
  if (!claims) return null;
  const reg = await withWorkspaceScope(claims.workspaceId, (tx) =>
    tx.opsEventRegistration.findFirst({
      where: { id: claims.registrationId, workspaceId: claims.workspaceId },
      include: {
        event: { select: { id: true, title: true, slug: true, venue: true, webinarUrl: true, startsAt: true, endsAt: true, timezone: true } },
        ticketType: { select: { name: true } },
        attendees: { orderBy: { createdAt: "asc" }, select: { id: true, name: true, status: true, checkedInAt: true, ticketCode: true } },
      },
    }),
  );
  if (!reg) return null;
  const confirmed = reg.status === "confirmed";
  return {
    id: reg.id,
    status: reg.status,
    name: reg.name,
    email: reg.email,
    quantity: reg.quantity,
    amountCents: reg.amountCents,
    currency: reg.currency,
    ticketName: reg.ticketType.name,
    event: { ...reg.event, webinarUrl: confirmed ? reg.event.webinarUrl : null },
    tickets: reg.attendees.map((a) => {
      if (!confirmed || a.status !== "confirmed") return { attendeeId: a.id, name: a.name, status: a.status, checkedInAt: a.checkedInAt, url: null, qrDataUrl: null };
      const url = ticketUrl(baseUrl, signTicket({ workspaceId: claims.workspaceId, eventId: reg.event.id, attendeeId: a.id, ticketCode: a.ticketCode }));
      return { attendeeId: a.id, name: a.name, status: a.status, checkedInAt: a.checkedInAt, url, qrDataUrl: `data:image/png;base64,${renderTicketQr(url).png.toString("base64")}` };
    }),
  };
}

/** One attendee's ticket by its signed ticket token (the QR's own page). */
export async function loadTicketByToken(token: string) {
  const claims = verifyTicket(token);
  if (!claims) return null;
  const a = await withWorkspaceScope(claims.workspaceId, (tx) =>
    tx.opsEventAttendee.findFirst({
      where: { id: claims.attendeeId, workspaceId: claims.workspaceId, eventId: claims.eventId },
      include: {
        ticketType: { select: { name: true } },
        event: { select: { title: true, slug: true, venue: true, webinarUrl: true, startsAt: true, endsAt: true, timezone: true } },
      },
    }),
  );
  if (!a || !sameTicketCode(a.ticketCode, claims.ticketCode)) return null;
  const confirmed = a.status === "confirmed";
  return {
    name: a.name,
    status: a.status,
    checkedInAt: a.checkedInAt,
    ticketType: a.ticketType.name,
    event: { ...a.event, webinarUrl: confirmed ? a.event.webinarUrl : null },
  };
}
