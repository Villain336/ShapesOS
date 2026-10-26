// ShapesOS — /dashboard/browser: the in-product browser "Dev preview" v1.
// Each open tab is one project's dev server, served by that project's
// persistent dev sandbox through the authenticated dev-preview proxy.
// Flag-gated (SHAPES_DEV_PREVIEW=1 or the shapes_dev_preview cookie);
// off means 404, same as the API routes.

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { needsOnboarding } from "@/lib/workspace/onboarding";
import { getI18n } from "@/lib/i18n/server";
import { prisma } from "@/lib/prisma";
import { BrowserPanel } from "@/components/browser/BrowserPanel";

export const dynamic = "force-dynamic";

export default async function BrowserPage() {
  const enabled =
    process.env.SHAPES_DEV_PREVIEW === "1" ||
    (await cookies()).get("shapes_dev_preview")?.value === "1";
  if (!enabled) notFound();

  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (needsOnboarding(workspace, null)) redirect("/dashboard/welcome");
  const { t } = await getI18n();

  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, name: true, domain: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  const labels = {
    newTab: t("browser.newTab"),
    closeTab: t("browser.closeTab"),
    project: t("browser.project"),
    pickProject: t("browser.pickProject"),
    port: t("browser.port"),
    openTab: t("browser.openTab"),
    start: t("browser.start"),
    starting: t("browser.starting"),
    resume: t("browser.resume"),
    resuming: t("browser.resuming"),
    pause: t("browser.pause"),
    paused: t("browser.paused"),
    none: t("browser.none"),
    empty: t("browser.empty"),
    stopsItself: t("browser.stopsItself"),
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BrowserPanel
        projects={projects.map((p) => ({ id: p.id, name: p.name ?? p.domain }))}
        labels={labels}
      />
    </div>
  );
}
