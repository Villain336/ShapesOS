// Marketr — Direct Mail settings page (Phase 4 T1).
// Admin+ only (server-gated). Provider cards for Lob + PostGrid with
// test/live mode badges, health, connect/disconnect. Key material is never
// displayed — only hints and mode flags.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import DirectMailSettings from "./DirectMailSettings";

export const dynamic = "force-dynamic";

export default async function DirectMailSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Direct Mail</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {workspace.name} — connect Lob or PostGrid to send addressed mail.
          Test keys first; live keys are fenced and can only spend behind an
          approved campaign. Key material is never displayed here.
        </p>
      </div>
      <SettingsNav />
      <DirectMailSettings />
    </div>
  );
}
