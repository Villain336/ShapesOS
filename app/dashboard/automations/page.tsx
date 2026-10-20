// ShapesOS — Phase 18.3 (WS=flow): Automations (/dashboard/automations).
// One list over the existing automation systems (lib/automations/list.ts),
// the trigger and action catalogues, and "Describe it" (editor+). Any member
// sees the list; on/off and Run now go to each system's own route, which
// decides. ?item=<kind>:<id> highlights one row.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { loadAutomations } from "@/lib/automations/list";
import { AutomationsApp } from "@/components/automations/AutomationsApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("flow.automations.title")} — ShapesOS`, description: t("flow.automations.subtitle") };
}

export default async function AutomationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const actor = { workspaceId: workspace.id, userId: user.id, role: membership.role };
  // Lazy: the action catalogue walks the whole agent tool registry, which the
  // production build should not compile into this page's static graph.
  const [data, skills, { actionCatalog, triggerCatalog }] = await Promise.all([
    loadAutomations(actor),
    withWorkspaceScope(workspace.id, (tx) => tx.skill.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true }, take: 200 })),
    import("@/lib/automations/catalog"),
  ]);
  const sp = await searchParams;
  const item = typeof sp.item === "string" && sp.item.length <= 200 ? sp.item : null;
  return (
    <AutomationsApp
      workspaceId={workspace.id}
      role={membership.role}
      initial={data}
      triggers={triggerCatalog()}
      actions={actionCatalog()}
      skills={skills}
      initialItem={item}
    />
  );
}
