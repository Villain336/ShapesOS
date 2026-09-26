// Marketr — workspace members settings page (milestone 11: RBAC).
// Admin+ only (server-gated). Invite by email, change roles, remove members.
// The last owner is protected by the API.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import MembersManager from "@/components/MembersManager";
import SettingsNav from "@/components/settings/SettingsNav";
import PermissionGrantsManager from "@/components/settings/PermissionGrantsManager";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, userId: true, email: true, name: true, role: true },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Workspace members</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          {workspace.name} — invite teammates and control what they can do.
          Roles: <span className="font-mono">owner</span> &gt;{" "}
          <span className="font-mono">admin</span> &gt;{" "}
          <span className="font-mono">editor</span> &gt;{" "}
          <span className="font-mono">viewer</span> (read-only).
        </p>
      </div>
      <SettingsNav />
      <MembersManager myRole={membership.role} />
      <PermissionGrantsManager
        workspaceId={workspace.id}
        members={members.map((m) => ({
          id: m.id,
          userId: m.userId,
          email: m.email,
          name: m.name,
          role: m.role,
        }))}
      />
    </div>
  );
}
