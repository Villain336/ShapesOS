// Marketr — Phase 8 G2: new campaign form page.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { NewCampaignForm } from "../client-actions";
import { campaignTablesReady } from "@/app/api/substrate/_lib";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "New campaign — ShapesOS",
  description: "Create a growth campaign object.",
};

export default async function NewCampaignPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) redirect("/dashboard/substrate/campaigns");
  if (!(await campaignTablesReady())) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="aos-heading">New campaign</h1>
        <p className="text-sm text-muted">
          Create the cross-channel object first — attach fragments (mail, email,
          social, ads, CTV, tests) afterward, or let the backfill proposer
          suggest historical links for review.
        </p>
      </div>
      <Card>
        <CardHeader title="Campaign details" />
        <CardBody>
          <NewCampaignForm />
        </CardBody>
      </Card>
    </div>
  );
}
