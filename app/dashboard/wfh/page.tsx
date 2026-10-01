// Marketr — Wave 2 WFH mode slice 1: mode switch page (Grow/Operate pillar).
//
// One toggle that reconfigures the OS for remote work: async-first
// notifications, protected focus time, home-office expense categories, and
// culture rituals. The toggle visibly changes the chrome via the live mode
// indicator badge.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { modeIndicator } from "@/lib/wfh/mode";
import WfhModePanel from "./_components/WfhModePanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "WFH mode — Marketr",
  description: "One switch that reconfigures the OS for remote work: async-first notifications, protected focus time, and rituals.",
};

export default async function WfhModePage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const row = await prisma.wfhWorkMode.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
  });
  const history = row
    ? await prisma.wfhModeHistory.findMany({
        where: { workModeId: row.id },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    : [];

  const initial = row
    ? {
        mode: row.mode,
        wfhDays: row.wfhDays,
        focusStartMin: row.focusStartMin,
        focusEndMin: row.focusEndMin,
        focusBlockMinutes: row.focusBlockMinutes,
        standupCadence: row.standupCadence,
        notificationProfile: row.notificationProfile,
        setupCompletedAt: row.setupCompletedAt?.toISOString() ?? null,
        indicator: modeIndicator({
          mode: row.mode as "wfh" | "office" | "hybrid",
          wfhDays: row.wfhDays,
          setupCompletedAt: row.setupCompletedAt,
        }),
      }
    : null;

  return (
    <div className="bg-[#FAFAF7] p-4 md:p-6">
      <h1 className="text-xl font-bold tracking-tight text-stone-900">WFH mode</h1>
      <p className="mt-1 text-[13px] text-stone-500">
        One switch that reconfigures the OS for remote work — async-first notifications,
        protected focus time, home-office expenses, and rituals. Per-user: your teammates
        keep their own setting.
      </p>
      <div className="mt-4">
        <WfhModePanel
          initial={initial}
          history={history.map((h) => ({
            id: h.id,
            previousMode: h.previousMode,
            newMode: h.newMode,
            reason: h.reason,
            createdAt: h.createdAt.toISOString(),
          }))}
        />
      </div>
    </div>
  );
}
