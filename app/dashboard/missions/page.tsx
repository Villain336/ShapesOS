// Marketr — Growth Missions home (Phase 9, M4).
// Durable, goal-shaped work: pick a template, set the target, launch.
// Tier 0: starting a mission drafts plans and executes nothing.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { MissionsApp } from "./MissionsApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Growth Missions — Marketr",
  description: "Durable, goal-shaped growth work: mission templates per business type, structured timelines, approval-gated execution.",
};

export default async function MissionsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Growth Missions</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Goal-shaped work — “get 40 booked jobs this quarter”, not a task list. Pick a template for your
          business type, set the target, and launch. Starting a mission drafts a plan; nothing executes
          without your approvals.
        </p>
      </div>
      <MissionsApp />
    </div>
  );
}
