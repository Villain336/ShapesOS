// Marketr — Wave 2 WFH mode slice 3: focus-time page (calendar-lite).
//
// Create protected deep-work blocks, preview conflicts against a manual event
// list, and enforce soft (decline-with-suggestion) or hard (auto-decline,
// consent-gated) protection. Live calendar OAuth is parked — the connection
// row and the one-time consent gate are real; the rail itself is a stub.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import WfhTabs from "../_components/WfhTabs";
import FocusPanel from "./_components/FocusPanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "WFH focus time — ShapesOS",
  description: "Protected deep-work blocks with soft or consent-gated hard protection.",
};

export default async function WfhFocusPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const [blocks, connections] = await Promise.all([
    prisma.wfhFocusBlock.findMany({
      where: { workspaceId: workspace.id, userId: user.id },
      orderBy: { startAt: "asc" },
      take: 100,
    }),
    prisma.wfhCalendarConnection.findMany({
      where: { workspaceId: workspace.id, userId: user.id },
    }),
  ]);

  return (
    <div className="bg-canvas p-4 md:p-6">
      <h1 className="aos-heading">WFH mode</h1>
      <p className="mt-1 text-sm text-muted">
        Sacred focus time: create protected deep-work blocks. Soft protection suggests new
        times for conflicts; hard protection auto-declines — with your one-time consent.
      </p>
      <div className="mt-3">
        <WfhTabs active="focus" />
      </div>
      <div className="mt-4">
        <FocusPanel
          initialBlocks={blocks.map((b) => ({
            id: b.id,
            title: b.title,
            startAt: b.startAt.toISOString(),
            endAt: b.endAt.toISOString(),
            recurrence: b.recurrence,
            protection: b.protection,
            source: b.source,
            status: b.status,
            defendedEventIds: b.defendedEventIds,
          }))}
          connections={connections.map((c) => ({
            provider: c.provider,
            status: c.status,
            autoDeclineConsentAt: c.autoDeclineConsentAt?.toISOString() ?? null,
          }))}
        />
      </div>
    </div>
  );
}
