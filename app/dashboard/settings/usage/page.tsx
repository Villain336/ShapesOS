// Marketr — workspace usage page (Phase C, W4).
// Admin+ only (server-gated): billing data stays with workspace admins.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import UsageDashboard from "@/components/settings/UsageDashboard";
import BillingSection from "@/components/settings/BillingSection";
// Phase 15.4 (zernio): connected Zernio accounts (appended section).
import ZernioUsageSection from "@/components/settings/ZernioUsageSection";

export const dynamic = "force-dynamic";

export default async function UsageSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Usage</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          {workspace.name} — credit usage this period, by action and by project,
          with the spend cap and CSV export for client chargeback.
        </p>
      </div>
      <SettingsNav />
      <UsageDashboard workspaceId={workspace.id} />
      <BillingSection workspaceId={workspace.id} />
      <ZernioUsageSection workspaceId={workspace.id} />
    </div>
  );
}
