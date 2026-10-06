// ShapesOS — Phase 18.2 (WS=comms): Meet — video meetings on LiveKit (a
// labelled "not configured" state when it isn't set up), started ad hoc,
// from a calendar event or from a channel; after the call, the meeting
// agent turns the transcript into a notes doc and reminders / ops tasks
// (lib/comms/meet). Viewer+; transcripts and notes are editor+.

import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { MeetApp } from "@/components/comms/MeetApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("comms.meet.title")} — ShapesOS`, description: t("comms.meet.metaDescription") };
}

const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);

export default async function MeetPage({ searchParams }: { searchParams: Promise<{ m?: string; session?: string; title?: string; origin?: string; ref?: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!me) redirect("/dashboard");
  const sp = await searchParams;
  const origin = sp.origin === "calendar" || sp.origin === "channel" ? sp.origin : null;
  const start =
    origin || typeof sp.title === "string"
      ? { title: typeof sp.title === "string" ? sp.title.slice(0, 200) : null, origin: origin ?? ("adhoc" as const), ref: origin && typeof sp.ref === "string" ? sp.ref.slice(0, 400) : null }
      : null;
  return <MeetApp canEdit={roleAtLeast(me.role, "editor")} initialMeeting={id(sp.m) ?? id(sp.session)} start={start} />;
}
