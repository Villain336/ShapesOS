// ShapesOS — unified "needs you" inbox (Phase 3 J; Agentic OS 4d).
//
// Every pending human approval across the workspace's queues — missions,
// ad spend, outreach and authority, nurture and messaging, insurance,
// scheduled runs, report sends, CAD changes, introductions, e-sign, tool
// actions, media buys and direct mail — as kit approval cards. Mission
// requests hang under the lead agent → the sub-agent waiting on them. Any
// member can see the queues their role can read; deciding still follows
// each queue's own rule (inline where the queue's API allows, otherwise a
// link to the queue's own approve/deny screen).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { isInboxSource } from "@/lib/approvals/types";
import { safeAgentActivity } from "@/lib/aos/activity.server";
import { missionAgentIndex } from "@/lib/aos/approvals";
import ApprovalsInbox from "./ApprovalsInbox";
// Phase 18.1 (WS=find): the page in the person's language.
import { getI18n } from "@/lib/i18n/server";

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

  // Which sub-agent each mission's approvals are waiting on (shared with the
  // sidebar's read for this request; best effort).
  const activity = await safeAgentActivity(workspace.id);
  const missionAgents = missionAgentIndex(activity?.tree?.missions ?? []);
  const { t } = await getI18n();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">{t("approvals.title")}</h1>
        <p className="mt-1 text-md text-muted">{t("approvals.subtitle", { workspace: workspace.name })}</p>
      </div>
      <ApprovalsInbox initialSource={initialSource} missionAgents={missionAgents} />
    </div>
  );
}
