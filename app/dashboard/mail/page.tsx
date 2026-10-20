// ShapesOS — Phase 18.2 (WS=comms): Mail — one inbox over your own Gmail /
// Outlook, the CRM lead conversations and social DMs (lib/comms/mail), with
// the inbox agent (summaries, suggested labels, drafted replies; triage as an
// agent run). Viewer+; replying to lead and social conversations is editor+.
// (Direct mail — postcards — moved to /dashboard/direct-mail.)

import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { MailApp } from "@/components/comms/MailApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("comms.mail.title")} — ShapesOS`, description: t("comms.mail.metaDescription") };
}

export default async function MailPage({ searchParams }: { searchParams: Promise<{ thread?: string; compose?: string; to?: string; subject?: string; body?: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!me) redirect("/dashboard");
  const sp = await searchParams;
  return (
    <MailApp
      canEdit={roleAtLeast(me.role, "editor")}
      initialThread={typeof sp.thread === "string" ? sp.thread.slice(0, 900) : null}
      initialCompose={
        sp.compose === "1"
          ? {
              to: typeof sp.to === "string" ? sp.to.slice(0, 300) : null,
              // Phase 18.3 (WS=flow): the share sheet's "Send to → Mail" prefills a new message.
              subject: typeof sp.subject === "string" ? sp.subject.slice(0, 200) : null,
              body: typeof sp.body === "string" ? sp.body.slice(0, 4000) : null,
            }
          : null
      }
    />
  );
}
