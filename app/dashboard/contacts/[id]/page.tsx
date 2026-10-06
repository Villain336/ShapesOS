// ShapesOS — Phase 18.2 (WS=comms): one person's contact card — every linked
// record with deep links, the timeline across them and actions. Viewer+;
// editors can unlink records and decide merge suggestions.

import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { ContactCard } from "@/components/comms/ContactCard";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("comms.contacts.title")} — ShapesOS`, description: t("comms.contacts.metaDescription") };
}

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!me) redirect("/dashboard");
  const { id } = await params;
  return <ContactCard identityId={String(id).slice(0, 64)} canEdit={roleAtLeast(me.role, "editor")} />;
}
