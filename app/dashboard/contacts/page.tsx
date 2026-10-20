// ShapesOS — Phase 18.2 (WS=comms): Contacts — one address book over leads,
// Ops contacts, the Network and funding contacts (identity links; merges only
// when a person confirms). Viewer+ reads; editors confirm merges.

import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { ContactsApp } from "@/components/comms/ContactsApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("comms.contacts.title")} — ShapesOS`, description: t("comms.contacts.metaDescription") };
}

export default async function ContactsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!me) redirect("/dashboard");
  const { tab } = await searchParams;
  return <ContactsApp canMerge={roleAtLeast(me.role, "editor")} initialTab={tab === "suggestions" ? "suggestions" : "people"} />;
}
