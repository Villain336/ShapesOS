// ShapesOS — Phase 18.2 (WS=comms): Messages — workspace channels, project
// chats and direct messages with threads, mentions and presence; agents are
// members (lib/comms/messages). Viewer+; starting an agent and approving
// what it proposes are editor+.

import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { MessagesApp } from "@/components/comms/MessagesApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("comms.messages.title")} — ShapesOS`, description: t("comms.messages.metaDescription") };
}

const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ c?: string; t?: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!me) redirect("/dashboard");
  const sp = await searchParams;
  return <MessagesApp userId={user.id} role={me.role} initialChannel={id(sp.c)} initialThread={id(sp.c) ? id(sp.t) : null} callsEnabled />;
}
