// Marketr — Growth Missions home (Phase 9, M4; Agentic OS 4d).
// Durable, goal-shaped work: pick a template, set the target, launch.
// Tier 0: starting a mission drafts plans and executes nothing.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { MissionsApp } from "./MissionsApp";
// Phase 18.2 (WS=content): templates removed in the Store are hidden from the picker.
import { removedMissionTemplates } from "@/lib/store/state";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Missions — ShapesOS",
  description: "Durable, goal-shaped growth work: mission templates per business type, structured timelines, approval-gated execution.",
};

export default async function MissionsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const hidden = [...(await removedMissionTemplates(workspace.id).catch(() => new Set<string>()))];
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Missions</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">
          Goals the agents are working on: “get 40 booked jobs this quarter”, not a task list. Strategist plans each one
          and hands the steps to sub-agents; nothing goes out without your approval.
        </p>
      </div>
      <MissionsApp hiddenTemplateIds={hidden} />
    </div>
  );
}
