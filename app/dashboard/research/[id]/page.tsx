// ShapesOS — Phase 21A round 2 (WS=agentweb): one research session (/dashboard/research/[id]).
// Its starter, or any member once it is shared. Private research that is not yours is a 404.

import { notFound, redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { getResearch } from "@/lib/agentweb/research/store";
import { getSessionView, listSessions } from "@/lib/agentweb/sessions/store";
import { ResearchDetail } from "@/components/research/ResearchDetail";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("researchApp.title")} — ShapesOS` };
}

export default async function ResearchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();
  const research = await getResearch(workspace.id, user.id, id, { includeWorkspace: true });
  if (!research) notFound();
  const [progress, all] = await Promise.all([research.runId ? getSessionView(workspace.id, research.runId) : Promise.resolve(null), research.owner ? listSessions(workspace.id, { limit: 50 }) : Promise.resolve([])]);
  const sessions = all
    .filter((s) => s.startedBy === user.id)
    .map((s) => ({ runId: s.runId, label: `${s.currentUrl ? s.currentUrl.replace(/^https?:\/\//, "").slice(0, 60) : s.runId} · ${s.steps}` }));
  return <ResearchDetail initial={research} progress={progress} sessions={sessions} canEdit={roleAtLeast(membership.role, "editor")} />;
}
