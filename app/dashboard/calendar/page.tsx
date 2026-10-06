// ShapesOS — Phase 18.2 (WS=comms): Calendar — month / week / day over the
// member's own connected calendars (Google, Outlook) and ShapesOS's bookings,
// focus blocks, events, scheduled posts, reminders and calls; find time;
// a private ICS feed. Viewer+ (each member sees their own calendars).

import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { CalendarApp } from "@/components/comms/CalendarApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("comms.calendar.title")} — ShapesOS`, description: t("comms.calendar.metaDescription") };
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await getMembership(user.id, workspace.id))) redirect("/dashboard");
  const { view } = await searchParams;
  return <CalendarApp initialView={view === "month" || view === "day" ? view : "week"} />;
}
