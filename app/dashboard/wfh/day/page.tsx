// Marketr — Wave 2 WFH mode slice 7: WFH day view page.
//
// The Sunsama-pattern daily plan: today's focus blocks, standup state,
// rituals due, and digest windows — one screen for the whole WFH day.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import WfhTabs from "../_components/WfhTabs";
import DayViewPanel from "./_components/DayViewPanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "WFH day view — Marketr",
  description: "Your WFH day at a glance: focus blocks, standup, rituals, digests.",
};

export default async function WfhDayPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="bg-[#FAFAF7] p-4 md:p-6">
      <h1 className="text-xl font-bold tracking-tight text-stone-900">WFH mode</h1>
      <p className="mt-1 text-[13px] text-stone-500">
        Your WFH day at a glance — focus blocks, standup, rituals, and digests.
      </p>
      <div className="mt-3">
        <WfhTabs active="day" />
      </div>
      <div className="mt-4">
        <DayViewPanel />
      </div>
    </div>
  );
}
