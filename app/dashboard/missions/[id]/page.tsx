// Marketr — Growth Mission detail (Phase 9, M4; Agentic OS 4d).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { MissionDetail } from "./MissionDetail";
// Phase 18.2 (WS=content): a record's notes.
import { RecordNotes } from "@/components/notes/RecordNotes";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Mission — ShapesOS",
  description: "Mission detail: the lead agent and its sub-agents, the mission timeline, approvals, and plan.",
};

export default async function MissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <MissionDetail missionId={id} />
      {/* Phase 18.2 (WS=content): the notes linked to this mission. */}
      <RecordNotes kind="mission" id={id} label="Mission" />
    </div>
  );
}
