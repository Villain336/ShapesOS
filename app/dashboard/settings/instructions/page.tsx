// Shared workspace instructions: every member can read them, admins edit.
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import InstructionsForm from "@/components/settings/InstructionsForm";

export const dynamic = "force-dynamic";

export default async function InstructionsSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Shared instructions</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          {workspace.name} - guidance your admins want agents to follow. Agents are asked to follow it, but it is guidance: it does not change approvals, spend limits or permissions.
        </p>
      </div>
      <SettingsNav />
      <InstructionsForm />
    </div>
  );
}
