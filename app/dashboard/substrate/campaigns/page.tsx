// Marketr — Campaign list (hierarchy-aware).
// Agentic OS: dense table, neutral status chips, page-shell chrome.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { listCampaigns } from "@/lib/substrate/campaigns/store";
import { campaignTablesReady } from "@/app/api/substrate/_lib";
import {
  Chip,
  PageTitle,
  rowCls,
  tableShell,
  thCls,
  theadCls,
} from "../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Campaigns — ShapesOS",
  description: "The cross-channel campaign object: one ID across mail, email, social, ads, CTV, and tests.",
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
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageTitle
          title="Campaigns"
          subtitle="One campaign object across every channel — links only, never re-modeled. The roll-up is reporting, not a spending envelope: nothing here moves money."
        />
        <div className="flex shrink-0 gap-1.5">
          <Chip>{campaigns.length} campaigns</Chip>
          <Chip>{rows.reduce((a, r) => a + r.linkCount, 0)} linked fragments</Chip>
        </div>
      </div>

      <div className={`${tableShell} mt-4`}>
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className={theadCls}>
              <th className={thCls}>Name</th>
              <th className={thCls}>Status</th>
              <th className={thCls}>Fragments</th>
              <th className={thCls}>Roll-up</th>
              <th className={thCls}>Objective</th>
            </tr>
          </thead>
          <tbody>
            {tree.map(({ row, depth }) => (
              <tr key={row.id} className={rowCls}>
                <td className="px-3 py-2" style={{ paddingLeft: 12 + depth * 24 }}>
                  <Link
                    href={`/dashboard/substrate/campaigns/${row.id}`}
                    className="font-medium text-ink hover:underline"
                  >
                    {row.name}
                  </Link>
                  {(row.childCount > 0 || row.parentCampaign) && (
                    <div className="text-[11px] text-muted">
                      {row.childCount > 0
                        ? `${row.childCount} sub-campaign${row.childCount === 1 ? "" : "s"}`
                        : ""}
                      {row.childCount > 0 && row.parentCampaign ? " · " : ""}
                      {row.parentCampaign ? `under ${row.parentCampaign.name}` : ""}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Chip>{row.status}</Chip>
                </td>
                <td className="px-3 py-2 tabular-nums text-muted">
                  {row.linkCount} fragment{row.linkCount === 1 ? "" : "s"}
                </td>
                <td className="px-3 py-2 tabular-nums text-muted">{fmtCents(row.budgetRollupCents)}</td>
                <td className="px-3 py-2 text-muted">{row.objective.replace("_", " ")}</td>
              </tr>
            ))}
            {tree.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[13px] text-subtle">
                  No campaigns yet. Create one on the New campaign tab, then attach fragments —
                  or run the backfill proposer on the Link proposals tab to link historical fragments.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[12px] text-muted">
        Hierarchy-aware: parents indent above their sub-campaigns (≤3 levels).
      </p>
    </div>
  );
}
