// ShapesOS — Phase 18.2 (WS=content): the Terminal (/dashboard/terminal).
// A shell on a workspace sandbox (lib/terminal/service.ts). Editors and up
// open one (the nav row is editor+ too); a viewer sees why it is off; with no
// sandbox provider the page says so and runs nothing.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { sandboxConfig } from "@/lib/sandbox/config";
import { myTerminalSession, terminalAvailability, terminalHistory } from "@/lib/terminal/service";
import { TerminalApp } from "@/components/terminal/TerminalApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("terminalApp.title")} — ShapesOS`, description: t("terminalApp.subtitle") };
}

export default async function TerminalPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const actor = { workspaceId: workspace.id, userId: user.id, role: membership.role };
  const canUse = roleAtLeast(membership.role, "editor");
  const [available, session] = await Promise.all([terminalAvailability(), canUse ? myTerminalSession(actor) : Promise.resolve(null)]);
  const history = session ? await terminalHistory(actor, session.id) : [];
  return (
    <TerminalApp
      available={available}
      canUse={canUse}
      initialSession={session}
      initialHistory={history.map((h) => h.command)}
      idleMinutes={Math.round(sandboxConfig().idleSeconds / 60)}
    />
  );
}
