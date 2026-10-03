// ShapesOS — unified "needs you" inbox (Phase 3 J).
//
// Every pending human approval across the workspace's queues — missions,
// ad spend, outreach and authority, nurture and messaging, insurance,
// scheduled runs, report sends, CAD changes, introductions, e-sign, tool
// actions, media buys and direct mail — in one dense table. Any member can
// see the queues their role can read; deciding still follows each queue's
// own rule (inline where the queue's API allows, otherwise a deep link to
// the queue's own approve/deny screen).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { isInboxSource } from "@/lib/approvals/types";
import ApprovalsInbox from "./ApprovalsInbox";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Needs you — ShapesOS",
  description:
    "Every approval waiting on a person, across all of your workspace's queues — approve, deny or open each one.",
};

export default async function ApprovalsPage({
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
  const rawSource = Array.isArray(sp.source) ? sp.source[0] : sp.source;
  const initialSource = isInboxSource(rawSource) ? rawSource : "all";

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Needs you</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name} — every approval waiting on a person, across all queues.
        </p>
      </div>
      <ApprovalsInbox initialSource={initialSource} />
    </div>
  );
}
