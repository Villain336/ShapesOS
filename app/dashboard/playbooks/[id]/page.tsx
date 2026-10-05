// Marketr — Agent Playbook detail (Phase 9 M5).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { PlaybookDetail } from "./PlaybookDetail";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Playbook — ShapesOS",
  description: "Playbook versions, outcome evaluations, and community sharing.",
};

export default async function PlaybookPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  const { id } = await params;
  return (
    <div className="bg-canvas p-4 md:p-6">
      <PlaybookDetail playbookId={id} />
    </div>
  );
}
