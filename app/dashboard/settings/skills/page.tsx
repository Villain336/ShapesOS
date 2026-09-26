// Marketr — workspace skills settings page (milestone 21, part D1).
// Admin+ only (server-gated). Install skills from the built-in registry,
// a GitHub URL (SHA-pinned), or a SKILL.md upload.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import SkillsManager from "@/components/settings/SkillsManager";

export const dynamic = "force-dynamic";

export default async function SkillsSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Skills</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          {workspace.name} — install skills that teach Marketr how your team
          does marketing. Enable them per project in project settings.
        </p>
      </div>
      <SettingsNav />
      <SkillsManager workspaceId={workspace.id} />
    </div>
  );
}
