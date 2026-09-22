// Marketr — workspace audit log page (milestone 21, part D1).
// Admin+ only (server-gated). Filterable audit table with CSV export
// (spec §5 flow 7).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import AuditLogViewer from "@/components/settings/AuditLogViewer";

export const dynamic = "force-dynamic";

export default async function AuditSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {workspace.name} — every skill install, connector change, file
          attachment, and settings update, with who and when.
        </p>
      </div>
      <SettingsNav />
      <AuditLogViewer workspaceId={workspace.id} />
    </div>
  );
}
