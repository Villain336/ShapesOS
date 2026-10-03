// ShapesOS CRM — conversation inbox (Phase 4b).
//
// Every lead's SMS and email thread in one place: outbound sends and inbound
// replies merged per lead, unread per member, reply composer that queues
// through the messaging approval path. Viewers read; editors reply.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { InboxApp } from "@/components/crm/InboxApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Inbox — ShapesOS",
  description: "Every lead conversation across SMS and email, with replies queued for approval.",
};

export default async function CrmInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");

  const sp = await searchParams;
  const rawLead = Array.isArray(sp.lead) ? sp.lead[0] : sp.lead;
  const initialLeadId = typeof rawLead === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(rawLead) ? rawLead : null;

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Inbox</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name} — lead conversations across SMS and email. Replies wait for approval before they go out.
        </p>
      </div>
      <InboxApp canReply={roleAtLeast(membership.role, "editor")} initialLeadId={initialLeadId} />
    </div>
  );
}
