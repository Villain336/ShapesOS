// Marketr — billing hub page (Phase 13 Wave A).
// Admin-only (server-gated): plan purchases, subscription management, and
// invoices stay with workspace admins. Reachable from Settings → Usage's
// Billing section ("Plans & subscription").

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import BillingHub from "@/components/settings/BillingHub";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return <BillingHub workspaceId={workspace.id} />;
}
