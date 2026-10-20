// Marketr — notification defaults settings page (milestone 21, part D1).
// Admin+ only (server-gated). Renders the notificationDefaults form.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import NotificationsForm from "@/components/settings/NotificationsForm";

export const dynamic = "force-dynamic";

export default async function NotificationsSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Notifications</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          {workspace.name} — workspace-wide notification defaults.
        </p>
      </div>
      <SettingsNav />
      <NotificationsForm workspaceId={workspace.id} />
    </div>
  );
}
