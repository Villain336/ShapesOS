// ShapesOS — Phase 21A round 2 (WS=agentweb): one browsing session (/dashboard/runs/sessions/[runId]):
// controls, the step the agent waits on, a console while you drive, and the replay from its receipts.

import { notFound, redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { getSessionView } from "@/lib/agentweb/sessions/store";
import { loadReplay } from "@/lib/agentweb/sessions/replay";
import { SessionDetail } from "@/components/sessions/SessionDetail";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("sessionsApp.detail.title")} — ShapesOS` };
}

export default async function SessionPage({ params }: { params: Promise<{ runId: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const { runId } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) notFound();
  const session = await getSessionView(workspace.id, runId);
  if (!session) notFound();
  return <SessionDetail initial={session} replay={await loadReplay(workspace.id, runId)} canSupervise={roleAtLeast(membership.role, "editor")} />;
}
