// ShapesOS — Phase 21A round 2 (WS=agentweb): Agent sessions (/dashboard/runs/sessions).
// Mission control for the web: every browsing session of this workspace. Any member may look;
// supervising (pause, take over, review each step) is editor+ and enforced by the API.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { listSessions } from "@/lib/agentweb/sessions/store";
import { listFlows } from "@/lib/agentweb/flows/store";
import { SessionsPanel } from "@/components/sessions/SessionsPanel";
import { FlowsPanel } from "@/components/sessions/FlowsPanel";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("sessionsApp.title")} — ShapesOS`, description: t("sessionsApp.subtitle") };
}

export default async function SessionsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const [sessions, flows] = await Promise.all([listSessions(workspace.id, { limit: 100 }), listFlows(workspace.id)]);
  return (
    <div className="flex flex-col gap-6">
      <SessionsPanel initial={sessions} />
      <FlowsPanel initial={flows} canEdit={roleAtLeast(membership.role, "editor")} />
    </div>
  );
}
