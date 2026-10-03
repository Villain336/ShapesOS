// ShapesOS — outbound webhooks settings (Phase 4a). Admin+ only (server-gated).
// Endpoints (URL, event filter, signing secret shown once, on/off, test,
// rotate, delete) and the delivery log with redeliver. Plan-gated.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import WebhooksManager from "@/components/settings/WebhooksManager";
import { UpgradeNotice } from "@/components/billing/UpgradeNotice";
import { featureUpgradeMessage, planHasFeature } from "@/lib/billing/entitlements";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Webhooks — ShapesOS",
  description: "Send signed events to your own endpoints when things happen in this workspace.",
};

export default async function WebhooksSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard/settings");
  const entitled = planHasFeature(workspace.plan, "webhooks");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Webhooks</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          {workspace.name}: signed HTTPS events when leads, invoices, approvals and agent runs change.
          Failed deliveries retry with backoff for about two days.
        </p>
      </div>
      <SettingsNav />
      {!entitled && <UpgradeNotice message={featureUpgradeMessage("webhooks")} />}
      <WebhooksManager entitled={entitled} />
    </div>
  );
}
