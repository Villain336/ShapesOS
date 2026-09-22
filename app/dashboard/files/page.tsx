// Marketr — workspace files page (Phase B, W3, track B1).
// Any workspace member can view; write actions are editor+ (API-enforced),
// purge is admin+.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { FileManager } from "@/components/FileManager";

export const dynamic = "force-dynamic";

export default async function FilesPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Files</h1>
        <p className="mt-1 text-sm text-ink-2">
          Your workspace&rsquo;s private filesystem — skills, memory, artifacts, and uploads.
          Everything here is scoped to this workspace.
        </p>
      </div>
      <FileManager
        workspaceId={workspace.id}
        canEdit={roleAtLeast(membership.role, "editor")}
        canPurge={roleAtLeast(membership.role, "admin")}
      />
    </div>
  );
}
