// ShapesOS — Phase 18.2 (WS=content): the Store (/dashboard/store).
// Any member browses (lib/store/service.ts); installing uses each kind's own
// permission (the service checks it); agency offers and publishing are for
// admins. ?item=<kind>:<key> opens one item.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, hasPermission, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { listClientWorkspaces, listPublications, loadStoreCatalogue } from "@/lib/store/service";
import { StoreApp } from "@/components/store/StoreApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("storeApp.title")} — ShapesOS`, description: t("storeApp.subtitle") };
}

export default async function StorePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const actor = { workspaceId: workspace.id, userId: user.id, role: membership.role };
  const admin = roleAtLeast(membership.role, "admin");
  const [catalogue, publications, clients, canInstallSkills] = await Promise.all([
    loadStoreCatalogue(actor),
    admin ? listPublications(actor) : Promise.resolve({ incoming: [], outgoing: [] }),
    admin ? listClientWorkspaces(workspace.id) : Promise.resolve([]),
    hasPermission(user.id, workspace.id, "skills.install"),
  ]);
  const sp = await searchParams;
  const item = typeof sp.item === "string" && sp.item.length <= 160 ? sp.item : null;
  return (
    <StoreApp
      initial={catalogue}
      initialPublications={publications}
      clients={clients}
      role={membership.role}
      canInstallSkills={canInstallSkills}
      initialItem={item}
    />
  );
}
