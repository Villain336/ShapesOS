// ShapesOS — billing hub page (Phase 13 Wave A; Phase 3 adds the grouped
// settings nav and the hosted trial state).
// Admin-only (server-gated): plan purchases, subscription management, and
// invoices stay with workspace admins. Reachable from Settings → Billing and
// usage, the workspace and account menus in the sidebar, and the trial banner.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { trialView } from "@/lib/billing/trial";
import BillingHub from "@/components/settings/BillingHub";
import SettingsNav from "@/components/settings/SettingsNav";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return <BillingHub workspaceId={workspace.id} nav={<SettingsNav />} trial={trialView(workspace)} />;
}
