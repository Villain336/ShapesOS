// ShapesOS — Phase 12 (people): /dashboard/ops/events — the workspace's
// events: dates, state, seats taken, registrations and check-ins. Writes go
// through the generic /api/ops/{events,…} routes (editor+, audited).

import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financePageActor } from "@/lib/ops/finance/page";
import { DataTable, Empty, FinanceHeader, Panel, Pill, cellCls, fmtDay, money, numCls, rowCls } from "@/components/ops-finance/kit";
import { NewEventButton } from "@/components/ops-people/EventsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Events — ShapesOS", description: "Events, tickets, registrations and check-in." };

const STATE: Record<string, string> = { draft: "Draft", published: "Published", cancelled: "Cancelled" };

export default async function EventsPage() {
  const actor = await financePageActor();
  const ws = actor.workspaceId;
  const data = await withWorkspaceScope(ws, async (tx) => {
    const events = await tx.opsEvent.findMany({ where: { workspaceId: ws }, orderBy: { startsAt: "desc" }, take: 200 });
    const ids = events.map((e) => e.id);
    const [paid, checkedIn] = ids.length
      ? await Promise.all([
          tx.opsEventRegistration.groupBy({ by: ["eventId"], where: { workspaceId: ws, eventId: { in: ids }, status: "confirmed" }, _sum: { amountCents: true }, _count: { _all: true } }),
          tx.opsEventAttendee.groupBy({ by: ["eventId"], where: { workspaceId: ws, eventId: { in: ids }, checkedInAt: { not: null } }, _count: { _all: true } }),
        ])
      : [[], []];
    return { events, paid: new Map(paid.map((p) => [p.eventId, p])), checkedIn: new Map(checkedIn.map((c) => [c.eventId, c._count._all])) };
  });
  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader
        title="Events"
        description="Events with sessions and ticket types, a public registration page, paid tickets through your Stripe, QR tickets and once-only check-in."
        actions={actor.canEdit ? <NewEventButton /> : null}
      />
      <Panel>
        {data.events.length === 0 ? (
          <Empty icon={<CalendarDays size={28} aria-hidden />} title="No events yet">
            Create an event, add a ticket type, and publish it to get a public registration page.
          </Empty>
        ) : (
          <DataTable head={[{ label: "Event" }, { label: "Starts" }, { label: "State" }, { label: "Seats taken", align: "right" }, { label: "Registrations", align: "right" }, { label: "Checked in", align: "right" }, { label: "Ticket sales", align: "right" }]}>
            {data.events.map((e) => {
              const p = data.paid.get(e.id);
              return (
                <tr key={e.id} className={rowCls}>
                  <td className={`${cellCls} font-semibold`}>
                    <Link className="underline-offset-2 hover:underline" href={`/dashboard/ops/events/${e.id}`}>
                      {e.title}
                    </Link>
                    <span className="aos-mono ml-2 text-xs font-normal text-muted">/events/{e.slug}</span>
                  </td>
                  <td className={`${cellCls} tabular-nums`}>{fmtDay(e.startsAt)}</td>
                  <td className={cellCls}>
                    <Pill>{STATE[e.status] ?? e.status}</Pill>
                  </td>
                  <td className={numCls}>
                    {e.reservedCount}
                    {e.capacity != null ? ` / ${e.capacity}` : ""}
                  </td>
                  <td className={numCls}>{p?._count._all ?? 0}</td>
                  <td className={numCls}>{data.checkedIn.get(e.id) ?? 0}</td>
                  <td className={numCls}>{money(p?._sum.amountCents ?? 0, e.currency)}</td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
