// Marketr — white-label settings page (Phase 13 Wave A, worker 6).
// Owner/admin-gated edits; other members see the settings read-only.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import WhiteLabelSettings from "@/components/settings/WhiteLabelSettings";

export const dynamic = "force-dynamic";

export default async function WhiteLabelSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const canEdit = (await requireWorkspaceRole(user.id, workspace.id, "admin")) !== null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">White-label</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          {workspace.name} — the client-facing identity: logo, custom domain, and brand color for public pages.
        </p>
      </div>
      <SettingsNav />
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
