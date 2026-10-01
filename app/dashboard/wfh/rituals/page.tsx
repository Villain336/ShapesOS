// Marketr — Wave 2 WFH mode slice 5: team rituals page.
//
// Opt-in rituals (wins, kudos, virtual coffee, demo Friday) on a cadence
// engine, with participation history and dead-ritual retirement surfacing.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import WfhTabs from "../_components/WfhTabs";
import RitualsPanel from "./_components/RitualsPanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "WFH team rituals — Marketr",
  description: "Opt-in team rituals with cadence, participation, and retirement surfacing.",
};

export default async function WfhRitualsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="bg-[#FAFAF7] p-4 md:p-6">
      <h1 className="text-xl font-bold tracking-tight text-stone-900">WFH mode</h1>
      <p className="mt-1 text-[13px] text-stone-500">
        Team rituals: wins, kudos, virtual coffee, demo Friday. All opt-in, on a
        cadence — dead rituals get surfaced for retirement, never silently rot.
      </p>
      <div className="mt-3">
        <WfhTabs active="rituals" />
      </div>
      <div className="mt-4">
        <RitualsPanel />
      </div>
    </div>
  );
}
