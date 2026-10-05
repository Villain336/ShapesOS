// ShapesOS — Phase 12 (people): /dashboard/ops/events/[id]/check-in — the
// door screen. Scan a QR ticket (scanner or camera); each attendee checks
// in once, a second scan says "already checked in". Editor+.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financePageActor } from "@/lib/ops/finance/page";
import { FinanceHeader, Panel } from "@/components/ops-finance/kit";
import { CheckInScreen } from "@/components/ops-people/CheckInClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Check-in — ShapesOS", description: "Scan QR tickets at the door." };

export default async function CheckInPage({ params }: PageProps<"/dashboard/ops/events/[id]/check-in">) {
  const actor = await financePageActor();
  const { id } = await params;
  if (!actor.canEdit) redirect(`/dashboard/ops/events/${id}`);
  const ws = actor.workspaceId;
  const data = await withWorkspaceScope(ws, async (tx) => {
    const event = await tx.opsEvent.findFirst({ where: { id, workspaceId: ws }, select: { id: true, title: true } });
    if (!event) return null;
    const [total, checkedIn] = await Promise.all([
      tx.opsEventAttendee.count({ where: { workspaceId: ws, eventId: id, status: "confirmed" } }),
      tx.opsEventAttendee.count({ where: { workspaceId: ws, eventId: id, status: "confirmed", checkedInAt: { not: null } } }),
    ]);
    return { event, total, checkedIn };
  });
  if (!data) notFound();
  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader
        title={`Check-in · ${data.event.title}`}
        description={
          <>
            Scan each ticket's QR code. Every ticket checks in once. <Link className="underline" href={`/dashboard/ops/events/${id}`}>Back to the event</Link>
          </>
        }
      />
      <Panel className="p-5">
        <CheckInScreen eventId={data.event.id} initialCount={data.checkedIn} total={data.total} />
      </Panel>
    </div>
  );
}
