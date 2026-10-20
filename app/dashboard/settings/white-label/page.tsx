// Marketr — white-label settings page (Phase 13 Wave A, worker 6).
// Owner/admin-gated edits; other members see the settings read-only.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import WhiteLabelSettings from "@/components/settings/WhiteLabelSettings";
import { UpgradeNotice } from "@/components/billing/UpgradeNotice";
import { featureUpgradeMessage, planHasFeature } from "@/lib/billing/entitlements";

export const dynamic = "force-dynamic";

export default async function WhiteLabelSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const isAdmin = (await requireWorkspaceRole(user.id, workspace.id, "admin")) !== null;
  // Phase 4a: white-label is a plan entitlement; without it the settings are
  // read-only and public pages render ShapesOS defaults.
  const entitled = planHasFeature(workspace.plan, "white_label");
  const canEdit = isAdmin && entitled;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">White-label</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          {workspace.name} — the client-facing identity: logo, custom domain, and brand color for public pages.
        </p>
      </div>
      <SettingsNav />
      {!entitled && (
        <UpgradeNotice message={featureUpgradeMessage("white_label")} canManageBilling={isAdmin} />
      )}
      {entitled && !planHasFeature(workspace.plan, "custom_domain") && (
        <UpgradeNotice message={featureUpgradeMessage("custom_domain")} canManageBilling={isAdmin} />
      )}
      <WhiteLabelSettings
        workspaceId={workspace.id}
        initial={{
          logoUrl: workspace.whiteLabelLogoUrl
            ? `/api/public/workspaces/${workspace.id}/logo`
            : null,
          customDomain: workspace.whiteLabelCustomDomain,
          brandColor: workspace.whiteLabelBrandColor,
        }}
        canEdit={canEdit}
      />
    </div>
  );
}
