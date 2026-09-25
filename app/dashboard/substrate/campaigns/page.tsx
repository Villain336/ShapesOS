// Marketr — Phase 8 G2: campaign list (hierarchy-aware).
// SPEC-PHASE8.md §6: campaign list (hierarchy-aware).

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { listCampaigns } from "@/lib/substrate/campaigns/store";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { Badge } from "@/components/vault/shadcn/badge";
import { campaignTablesReady } from "@/app/api/substrate/_lib";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Campaigns — Marketr",
  description: "The cross-channel campaign object: one ID across mail, email, social, ads, CTV, and tests.",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "secondary",
  active: "default",
  paused: "outline",
  complete: "secondary",
  archived: "outline",
};

interface Row {
  id: string;
  name: string;
  objective: string;
  status: string;
  parentCampaignId: string | null;
  parentCampaign: { id: string; name: string } | null;
  linkCount: number;
  childCount: number;
  budgetRollupCents: number;
}

function buildTree(rows: Row[]): Array<{ row: Row; depth: number }> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Array<{ row: Row; depth: number }> = [];
  const visit = (r: Row, depth: number) => {
    out.push({ row: r, depth });
    for (const child of rows.filter((c) => c.parentCampaignId === r.id)) visit(child, depth + 1);
  };
  for (const r of rows) {
    if (!r.parentCampaignId || !byId.has(r.parentCampaignId)) visit(r, 0);
  }
  return out;
}

function fmtCents(c: number): string {
  return `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export default async function CampaignsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  if (!(await campaignTablesReady())) redirect("/dashboard");

  const campaigns = await listCampaigns(workspace.id);
  const rows: Row[] = campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    objective: c.objective,
    status: c.status,
    parentCampaignId: c.parentCampaignId,
    parentCampaign: c.parentCampaign,
    linkCount: c._count.links,
    childCount: c._count.children,
    budgetRollupCents: c.budgetRollupCents,
  }));
  const tree = buildTree(rows);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
          <p className="text-sm text-muted-foreground">
            One campaign object across every channel — links only, never re-modeled.
            The roll-up is reporting, not a spending envelope: nothing here moves money.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Badge variant="secondary">{campaigns.length} campaigns</Badge>
          <Badge variant="outline">{rows.reduce((a, r) => a + r.linkCount, 0)} linked fragments</Badge>
        </div>
      </div>

      <Card>
        <CardHeader
          title="All campaigns"
          description="Hierarchy-aware: parents indent above their sub-campaigns (≤3 levels)."
        />
        <CardBody>
          {tree.length === 0 ? (
            <EmptyState
              title="No campaigns yet"
              description="Create your first campaign object, then attach fragments — or run the backfill proposer on the Link proposals tab to link historical fragments."
            />
          ) : (
            <ul className="divide-y">
              {tree.map(({ row, depth }) => (
                <li key={row.id} className="flex items-center justify-between gap-3 py-3" style={{ paddingLeft: depth * 24 }}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link href={`/dashboard/substrate/campaigns/${row.id}`} className="truncate text-sm font-medium hover:underline">
                        {row.name}
                      </Link>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {row.objective.replace("_", " ")} · {row.linkCount} fragment{row.linkCount === 1 ? "" : "s"}
                      {row.childCount > 0 ? ` · ${row.childCount} sub-campaign${row.childCount === 1 ? "" : "s"}` : ""}
                      {row.parentCampaign ? ` · under ${row.parentCampaign.name}` : ""}
                      {" · roll-up "}{fmtCents(row.budgetRollupCents)}
                    </p>
                  </div>
                  <Badge variant={STATUS_VARIANT[row.status] ?? "secondary"} className="shrink-0">
                    {row.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
