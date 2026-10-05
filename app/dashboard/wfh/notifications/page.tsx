// Marketr — Wave 2 WFH mode slice 2: async-first notifications page.
//
// Shows the digest configuration, the live queue, and per-window digest
// previews. Urgent notifications (approvals, money, customer-facing) always
// break through — everything else waits for a digest window while WFH mode
// is effectively on.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import WfhTabs from "../_components/WfhTabs";
import NotificationsPanel from "./_components/NotificationsPanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "WFH notifications — ShapesOS",
  description: "Async-first notification digests: urgent breaks through, the rest waits for a window.",
};

function fmtMin(min: number) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export default async function WfhNotificationsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const row = await prisma.wfhWorkMode.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    select: {
      mode: true,
      notificationProfile: true,
      digestTimesMin: true,
      setupCompletedAt: true,
    },
  });

  const queued = await prisma.wfhDigestItem.findMany({
    where: { workspaceId: workspace.id, userId: user.id, status: "queued" },
    orderBy: [{ windowMin: "asc" }, { queuedAt: "asc" }],
    take: 200,
  });

  return (
    <div className="bg-canvas p-4 md:p-6">
      <h1 className="aos-heading">WFH mode</h1>
      <p className="mt-1 text-sm text-muted">
        Async-first notifications: urgent breaks through immediately — approval gates, money
        movement, customer-facing — everything else batches into digest windows.
      </p>
      <div className="mt-3">
        <WfhTabs active="notifications" />
      </div>
      <div className="mt-4">
        <NotificationsPanel
          initialProfile={row?.notificationProfile ?? "batched"}
          initialTimes={row?.digestTimesMin ?? []}
          modeActive={row?.mode !== "office" && row?.mode != null}
          setupDone={row?.setupCompletedAt != null}
          queued={queued.map((q) => ({
            id: q.id,
            kind: q.kind,
            title: q.title,
            windowMin: q.windowMin,
            windowLabel: fmtMin(q.windowMin),
            queuedAt: q.queuedAt.toISOString(),
          }))}
        />
      </div>
    </div>
  );
}
