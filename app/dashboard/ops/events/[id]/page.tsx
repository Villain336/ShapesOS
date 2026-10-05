// ShapesOS — Phase 12 (people): /dashboard/ops/events/[id] — one event:
// publish switch, public link, reminders, sessions, ticket types (with seats
// sold), registrations (staff can add free or complimentary ones, or cancel)
// and attendees with their check-in state. The door screen is
// /dashboard/ops/events/[id]/check-in.

import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { ExternalLink, ScanLine } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financePageActor } from "@/lib/ops/finance/page";
import { appBaseUrl } from "@/lib/workspace/invite-mail";
import { registrationLabel } from "@/lib/ops/events/registrations";
import { aosButton } from "@/components/aos";
import { DataTable, ErrorLine, FinanceHeader, Note, Panel, Pill, cellCls, fmtDay, money, numCls, rowCls } from "@/components/ops-finance/kit";
import {
  AddRegistrationButton,
  AddSessionButton,
  AddTicketButton,
  CancelRegistrationButton,
  EventStatusActions,
  ReminderSequencePicker,
  TicketActiveToggle,
} from "@/components/ops-people/EventsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Event — ShapesOS", description: "One event: tickets, registrations and check-in." };

const STATE: Record<string, string> = { draft: "Draft", published: "Published", cancelled: "Cancelled" };
const REG: Record<string, string> = { pending: "Awaiting payment", confirmed: "Confirmed", cancelled: "Cancelled", expired: "Expired" };

const dt = (d: Date, tz: string) => {
  try {
    return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: tz });
  } catch {
    return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  }
};

export default async function EventPage({ params, searchParams }: PageProps<"/dashboard/ops/events/[id]">) {
  const actor = await financePageActor();
  const ws = actor.workspaceId;
  const { id } = await params;
  const sp = await searchParams;
  const data = await withWorkspaceScope(ws, async (tx) => {
    const event = await tx.opsEvent.findFirst({ where: { id, workspaceId: ws } });
    if (!event) return null;
    const [sessions, tickets, registrations, attendees, sequences, finance] = await Promise.all([
      tx.opsEventSession.findMany({ where: { workspaceId: ws, eventId: id }, orderBy: [{ startsAt: "asc" }, { position: "asc" }] }),
      tx.opsEventTicketType.findMany({ where: { workspaceId: ws, eventId: id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
      tx.opsEventRegistration.findMany({ where: { workspaceId: ws, eventId: id }, orderBy: { createdAt: "desc" }, take: 500 }),
      tx.opsEventAttendee.findMany({ where: { workspaceId: ws, eventId: id }, orderBy: { name: "asc" }, take: 1000, select: { id: true, name: true, email: true, status: true, checkedInAt: true, registrationId: true, ticketTypeId: true } }),
      tx.nurtureSequence.findMany({ where: { workspaceId: ws, status: { not: "archived" } }, orderBy: { name: "asc" }, select: { id: true, name: true, status: true } }),
      tx.opsFinanceSettings.findUnique({ where: { workspaceId: ws }, select: { stripeSecretEnc: true, stripeWebhookSecretEnc: true } }),
    ]);
    return { event, sessions, tickets, registrations, attendees, sequences, stripe: Boolean(finance?.stripeSecretEnc), webhook: Boolean(finance?.stripeWebhookSecretEnc) };
  });
  if (!data) notFound();
  const { event: e } = data;
  const h = await headers();
  const origin = h.get("host") ? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}` : "";
  const publicUrl = `${appBaseUrl(process.env, origin) ?? origin}/events/${e.slug}`;
  const ticketName = new Map(data.tickets.map((t) => [t.id, t.name]));
  const sessionName = new Map(data.sessions.map((s) => [s.id, s.title]));
  const hasPaid = data.tickets.some((t) => t.priceCents > 0 && t.active);
  const confirmedAttendees = data.attendees.filter((a) => a.status === "confirmed");
  const checkedIn = confirmedAttendees.filter((a) => a.checkedInAt).length;
  const error = typeof sp.error === "string" ? sp.error : null;

  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader
        title={e.title}
        description={
          <>
            {dt(e.startsAt, e.timezone)} – {dt(e.endsAt, e.timezone)} · {e.venue ?? (e.webinarUrl ? "Online" : "No venue set")} · <Pill>{STATE[e.status] ?? e.status}</Pill>
          </>
        }
        actions={actor.canEdit ? <EventStatusActions id={e.id} status={e.status} title={e.title} /> : null}
      />
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="flex flex-wrap items-center gap-2">
        <a className={aosButton({ variant: "secondary", size: "sm" })} href={publicUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={16} aria-hidden /> Public page
        </a>
        <Link className={aosButton({ variant: "primary", size: "sm" })} href={`/dashboard/ops/events/${e.id}/check-in`}>
          <ScanLine size={16} aria-hidden /> Check-in screen
        </Link>
        <span className="aos-mono text-xs text-muted">{publicUrl}</span>
      </div>
      {e.status === "draft" ? <Note>This event is a draft: the public page answers “not found” until you publish it.</Note> : null}
      {hasPaid && !data.stripe ? <Note>Paid tickets can't be sold until Stripe is connected in Finance settings.</Note> : null}
      {hasPaid && data.stripe && !data.webhook ? <Note>Add the Stripe webhook signing secret in Finance settings — paid registrations are only confirmed by Stripe's webhook.</Note> : null}
      <Panel title="Seats">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 py-4 text-md sm:grid-cols-4">
          <div>
            <dt className="text-xs font-semibold text-muted">Seats taken</dt>
            <dd className="tabular-nums text-base font-semibold">
              {e.reservedCount}
              {e.capacity != null ? ` of ${e.capacity}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-muted">Confirmed attendees</dt>
            <dd className="tabular-nums text-base font-semibold">{confirmedAttendees.length}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-muted">Checked in</dt>
            <dd className="tabular-nums text-base font-semibold">{checkedIn}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-muted">Ticket sales</dt>
            <dd className="tabular-nums text-base font-semibold">{money(data.registrations.filter((r) => r.status === "confirmed").reduce((s, r) => s + r.amountCents, 0), e.currency)}</dd>
          </div>
        </dl>
      </Panel>
      <Panel title="Reminders">
        {actor.canEdit ? <ReminderSequencePicker id={e.id} current={e.reminderSequenceId} sequences={data.sequences} /> : <p className="px-5 py-4 text-md text-muted">{e.reminderSequenceId ? "Confirmed registrants get the reminder sequence." : "No reminders set."}</p>}
      </Panel>
      <Panel title="Sessions" actions={actor.canEdit && e.status !== "cancelled" ? <AddSessionButton eventId={e.id} /> : null}>
        {data.sessions.length === 0 ? (
          <p className="px-5 py-4 text-md text-muted">One session: the event itself. Add sessions for a multi-part agenda or separately ticketed workshops.</p>
        ) : (
          <DataTable head={[{ label: "Session" }, { label: "When" }, { label: "Where" }, { label: "Seats taken", align: "right" }]}>
            {data.sessions.map((s) => (
              <tr key={s.id} className={rowCls}>
                <td className={`${cellCls} font-semibold`}>{s.title}</td>
                <td className={`${cellCls} tabular-nums`}>{dt(s.startsAt, e.timezone)}</td>
                <td className={cellCls}>{s.venue ?? (s.webinarUrl ? "Online" : "—")}</td>
                <td className={numCls}>
                  {s.reservedCount}
                  {s.capacity != null ? ` / ${s.capacity}` : ""}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
      <Panel title="Ticket types" actions={actor.canEdit && e.status !== "cancelled" ? <AddTicketButton eventId={e.id} sessions={data.sessions.map((s) => ({ id: s.id, title: s.title }))} /> : null}>
        {data.tickets.length === 0 ? (
          <p className="px-5 py-4 text-md text-muted">Add a ticket type before publishing — free or paid, with an optional quantity and sales window.</p>
        ) : (
          <DataTable head={[{ label: "Ticket" }, { label: "Admits to" }, { label: "Price", align: "right" }, { label: "Sold", align: "right" }, { label: "Sales window" }, { label: "" }]}>
            {data.tickets.map((t) => (
              <tr key={t.id} className={rowCls}>
                <td className={`${cellCls} font-semibold`}>
                  {t.name} {t.active ? null : <Pill className="ml-2">Not selling</Pill>}
                </td>
                <td className={cellCls}>{t.sessionId ? sessionName.get(t.sessionId) ?? "A session" : "Whole event"}</td>
                <td className={numCls}>{t.priceCents > 0 ? money(t.priceCents, e.currency) : "Free"}</td>
                <td className={numCls}>
                  {t.soldCount}
                  {t.quantity != null ? ` / ${t.quantity}` : ""}
                </td>
                <td className={`${cellCls} tabular-nums text-muted`}>
                  {t.salesStartAt || t.salesEndAt ? `${t.salesStartAt ? fmtDay(t.salesStartAt) : "now"} – ${t.salesEndAt ? fmtDay(t.salesEndAt) : "the event"}` : "Open"}
                </td>
                <td className={`${cellCls} text-right`}>{actor.canEdit ? <TicketActiveToggle id={t.id} active={t.active} /> : null}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
      <Panel
        title={`Registrations (${data.registrations.length})`}
        actions={actor.canEdit && e.status !== "cancelled" ? <AddRegistrationButton tickets={data.tickets.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, priceCents: t.priceCents }))} /> : null}
      >
        {data.registrations.length === 0 ? (
          <p className="px-5 py-4 text-md text-muted">No registrations yet.</p>
        ) : (
          <DataTable head={[{ label: "Registration" }, { label: "Who" }, { label: "Ticket" }, { label: "State" }, { label: "Seats", align: "right" }, { label: "Paid", align: "right" }, { label: "Source" }, { label: "" }]}>
            {data.registrations.map((r) => (
              <tr key={r.id} className={rowCls}>
                <td className={`${cellCls} aos-mono text-xs`}>{registrationLabel(r.id)}</td>
                <td className={cellCls}>
                  <span className="font-semibold">{r.name}</span> <span className="text-sm text-muted">{r.email}</span>
                </td>
                <td className={cellCls}>{ticketName.get(r.ticketTypeId) ?? "—"}</td>
                <td className={cellCls}>
                  <Pill>{REG[r.status] ?? r.status}</Pill>
                  {r.remindersEnrolledAt ? <span className="ml-2 text-xs text-muted">reminders on</span> : null}
                </td>
                <td className={numCls}>{r.quantity}</td>
                <td className={numCls}>{r.amountCents > 0 ? money(r.amountCents, r.currency) : r.unitPriceCents === 0 && r.source !== "public" ? "Comp / free" : "Free"}</td>
                <td className={`${cellCls} text-muted`}>{r.source}</td>
                <td className={`${cellCls} text-right`}>
                  {actor.canEdit && (r.status === "pending" || r.status === "confirmed") ? <CancelRegistrationButton id={r.id} label={registrationLabel(r.id)} paid={r.amountCents > 0 && r.status === "confirmed"} /> : null}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
      <Panel title={`Attendees (${confirmedAttendees.length} confirmed)`}>
        {data.attendees.length === 0 ? (
          <p className="px-5 py-4 text-md text-muted">Attendees appear as people register.</p>
        ) : (
          <DataTable head={[{ label: "Attendee" }, { label: "Ticket" }, { label: "State" }, { label: "Checked in" }]}>
            {data.attendees.map((a) => (
              <tr key={a.id} className={rowCls}>
                <td className={cellCls}>
                  <span className="font-semibold">{a.name}</span> {a.email ? <span className="text-sm text-muted">{a.email}</span> : null}
                </td>
                <td className={cellCls}>{ticketName.get(a.ticketTypeId) ?? "—"}</td>
                <td className={cellCls}>
                  <Pill>{REG[a.status] ?? a.status}</Pill>
                </td>
                <td className={`${cellCls} tabular-nums text-muted`}>{a.checkedInAt ? dt(a.checkedInAt, e.timezone) : "—"}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
