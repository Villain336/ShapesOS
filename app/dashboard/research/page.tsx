// ShapesOS — Phase 21A round 2 (WS=agentweb): Research (/dashboard/research).
// Any member may use it: their own research, the research teammates shared, their own browsing
// memory (never anyone else's), and the page monitors. Linking a monitor to a workflow is editor+.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { listResearch } from "@/lib/agentweb/research/store";
import { memoryOverview } from "@/lib/agentweb/memory/route-core";
import { monitorsOverview } from "@/lib/agentweb/research/monitors";
import { ResearchHome } from "@/components/research/ResearchHome";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("researchApp.title")} — ShapesOS`, description: t("researchApp.subtitle") };
}

export default async function ResearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const sp = await searchParams;
  const tab = sp.tab === "memory" || sp.tab === "monitors" ? sp.tab : "research";
  const item = typeof sp.item === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(sp.item) ? sp.item : null;
  const [research, memory, monitors] = await Promise.all([listResearch(workspace.id, user.id), memoryOverview({ userId: user.id, workspaceId: workspace.id }), monitorsOverview(workspace.id)]);
  return <ResearchHome tab={tab} research={research} memory={memory} monitors={monitors} canEdit={roleAtLeast(membership.role, "editor")} focusItem={item} />;
}
