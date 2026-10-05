// ShapesOS — Settings → General (Phase 3, workstream I).
// Any member can open it (create a workspace, see the plan); rename and
// setup are admin+, delete is owner only — all re-checked by the API.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace, getAccessibleWorkspaces } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { planDisplayName } from "@/lib/billing/plans";
import { trialView } from "@/lib/billing/trial";
import SettingsNav from "@/components/settings/SettingsNav";
import WorkspaceGeneral from "@/components/workspace/WorkspaceGeneral";

export const dynamic = "force-dynamic";

export const metadata = { title: "General settings — ShapesOS" };

export default async function WorkspaceSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const [me, accessible] = await Promise.all([
    getMembership(user.id, workspace.id),
    getAccessibleWorkspaces(user.id),
  ]);
  if (!me) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">General</h1>
        <p className="mt-0.5 text-sm text-muted">{workspace.name}: name, plan, setup, and workspaces.</p>
      </div>
      <SettingsNav />
      <WorkspaceGeneral
        workspace={{ id: workspace.id, name: workspace.name, plan: workspace.plan }}
        role={me.role}
        planLabel={planDisplayName(workspace.plan)}
        trial={trialView(workspace)}
        onboardingCompleted={!!workspace.onboardingCompletedAt}
        isLastWorkspace={accessible.length <= 1}
      />
    </div>
  );
}
