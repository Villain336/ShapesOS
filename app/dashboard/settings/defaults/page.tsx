// Marketr — workspace defaults settings page (milestone 21, part D1).
// Admin+ only (server-gated). Default model, approval mode, and agent
// tool allow-list — inherited by every project unless overridden.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import DefaultsForm from "@/components/settings/DefaultsForm";

export const dynamic = "force-dynamic";

export default async function DefaultsSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Defaults</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {workspace.name} — the baseline every project inherits: model,
          approval mode, and which tool namespaces the agent may use.
        </p>
      </div>
      <SettingsNav />
      <DefaultsForm workspaceId={workspace.id} />
    </div>
  );
}
