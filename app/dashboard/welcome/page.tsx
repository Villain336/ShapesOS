// ShapesOS — first-run setup (Phase 3, workstream I). The dashboard home
// sends admins of a brand-new workspace here once; afterwards it stays
// reachable from Settings → General ("Open setup").

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import {
  BUSINESS_TYPES,
  GOALS,
  connectionSuggestions,
  loadOnboardingState,
} from "@/lib/workspace/onboarding";
import OnboardingWizard from "@/components/workspace/OnboardingWizard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Set up your workspace — ShapesOS" };

export default async function WelcomePage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) redirect("/dashboard");
  const state = await loadOnboardingState(workspace.id);

  return (
    <OnboardingWizard
      initial={{
        // A finished setup reopened from settings starts at the top.
        step: state.completed ? "name" : state.step,
        workspaceName: state.workspaceName,
        profile: state.profile,
        hasProject: state.hasProject,
      }}
      suggestions={connectionSuggestions(state.profile)}
      businessTypes={BUSINESS_TYPES}
      goals={GOALS}
    />
  );
}
