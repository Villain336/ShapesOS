// Marketr — workspace members settings page (milestone 11: RBAC).
// Admin+ only (server-gated). Invite by email, change roles, remove members.
// The last owner is protected by the API.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import MembersManager from "@/components/MembersManager";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Workspace members</h1>
        <p className="mt-1 text-sm text-zinc-400">
          {workspace.name} — invite teammates and control what they can do.
          Roles: <span className="font-mono">owner</span> &gt;{" "}
          <span className="font-mono">admin</span> &gt;{" "}
          <span className="font-mono">editor</span> &gt;{" "}
          <span className="font-mono">viewer</span> (read-only).
        </p>
      </div>
      <MembersManager myRole={membership.role} />
    </div>
  );
}
