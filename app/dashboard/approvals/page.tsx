// Marketr — approvals inbox page (Phase 9 M6).
// Server-gated: editor+ only (deciding approvals is a mutation). Renders the
// pending-approvals table with mobile-usable Approve/Deny buttons.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import ApprovalsInbox from "./ApprovalsInbox";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Approvals inbox — Marketr",
  description:
    "Pending approvals across your missions — approve or deny with one tap, on desktop or mobile.",
};

export default async function ApprovalsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Approvals inbox</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name} — every action waiting on your sign-off, across all missions.
        </p>
      </div>
      <ApprovalsInbox />
    </div>
  );
}
