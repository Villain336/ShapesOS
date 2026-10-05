// ShapesOS — notification center (Phase 3 J).
// The signed-in member's own notifications in the current workspace: new
// approvals, decisions on their requests, alerts, failed agent runs and
// teammates joining. Read state is per member.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import NotificationsList from "./NotificationsList";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Notifications — ShapesOS",
  description: "Approvals waiting on you, decisions on your requests, alerts, failed runs and team changes.",
};

export default async function NotificationsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await getMembership(user.id, workspace.id))) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Notifications</h1>
        <p className="mt-1 text-md text-muted">
          What your agents and team need you to know in {workspace.name}: approvals, decisions, alerts, failed runs and
          team changes.
        </p>
      </div>
      <NotificationsList />
    </div>
  );
}
