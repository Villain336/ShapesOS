// Marketr — data governance settings page (milestone 21, part D1).
// Admin+ only (server-gated). Renders the friendly governance form over the
// workspace dataGovernance JSON.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import GovernanceForm from "@/components/settings/GovernanceForm";

export const dynamic = "force-dynamic";

export default async function GovernanceSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Data governance</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          {workspace.name} — retention and sharing defaults, inherited by every
          project.
        </p>
      </div>
      <SettingsNav />
      <GovernanceForm workspaceId={workspace.id} />
    </div>
  );
}
