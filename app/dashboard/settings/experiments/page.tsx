// Marketr — experiments settings page (Phase 12 "embeds": GrowthBook).
// Admin-gated. Lists flags from the GrowthBook sidecar with an operator
// toggle; honest built-in-defaults fallback when unconfigured.

import { redirect } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import { FlagsTable } from "@/components/experiments/FlagsTable";

export const dynamic = "force-dynamic";

export default async function ExperimentsSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Experiments</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          {workspace.name} — feature flags and experiments, powered by a
          self-hosted GrowthBook sidecar (open core, MIT bulk).
        </p>
      </div>
      <SettingsNav />

      <div className="flex items-center gap-1 border-b border-line">
        <span className="inline-flex items-center gap-1.5 border-b-2 border-ink px-3 py-2 text-[13px] font-medium text-ink">
          <FlaskConical className="h-4 w-4" />
          Flags
        </span>
      </div>

      <FlagsTable />
    </div>
  );
}
