// Marketr — Growth Mission detail (Phase 9, M4).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { MissionDetail } from "./MissionDetail";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Mission — Marketr",
  description: "Mission detail: goal, event timeline, approval queue, and plan.",
};

export default async function MissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  const { id } = await params;
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <MissionDetail missionId={id} />
    </div>
  );
}
