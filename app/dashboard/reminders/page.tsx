// ShapesOS — Phase 18.2 (WS=comms): Reminders — your own to-dos (OpsTask
// with no project, assigned to you), with due-time notifications.
// Viewer+; every reminder is personal (lib/comms/reminders.ts).

import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { RemindersApp } from "@/components/comms/RemindersApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("comms.reminders.title")} — ShapesOS`, description: t("comms.reminders.metaDescription") };
}

export default async function RemindersPage({ searchParams }: { searchParams: Promise<{ reminder?: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await getMembership(user.id, workspace.id))) redirect("/dashboard");
  const { reminder } = await searchParams;
  return <RemindersApp highlightId={typeof reminder === "string" ? reminder.slice(0, 64) : null} />;
}
