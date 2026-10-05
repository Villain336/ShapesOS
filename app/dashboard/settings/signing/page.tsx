// Marketr — signing settings page (Phase 12 "embeds": Documenso API-only).
// Admin-gated. API-only signing requests — NO embedded signing UI (that
// needs Documenso's commercial license).

import { redirect } from "next/navigation";
import { PenLine } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import { SigningPanel } from "@/components/settings/SigningPanel";
import { documensoStatus } from "@/lib/integrations/documenso";
import { withWorkspaceSidecars } from "@/lib/integrations/sidecar-tenancy";

export const dynamic = "force-dynamic";

export default async function SigningSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  // Phase 15.1: this workspace's own Documenso (a shared one is refused on hosted).
  const status = await withWorkspaceSidecars(workspace.id, () => documensoStatus());

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Signing</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name} — e-signature requests via Documenso (AGPL Community
          Edition, API-only against an unmodified instance).
        </p>
      </div>
      <SettingsNav />

      <div className="flex items-center gap-1 border-b border-line">
        <span className="inline-flex items-center gap-1.5 border-b-2 border-ink px-3 py-2 text-sm font-semibold text-ink">
          <PenLine className="h-4 w-4" />
          Signing requests
        </span>
      </div>

      <SigningPanel configured={status.configured} />
    </div>
  );
}
