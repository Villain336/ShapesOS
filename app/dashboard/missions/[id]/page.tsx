// Marketr — Growth Mission detail (Phase 9, M4; Agentic OS 4d).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { MissionDetail } from "./MissionDetail";

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
  return <MissionDetail missionId={id} />;
}
