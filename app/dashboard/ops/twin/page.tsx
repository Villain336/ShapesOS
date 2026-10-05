// ShapesOS Phase 13 — /dashboard/ops/twin: the digital twin's sites
// (warehouses, factories, stores) as a dense table, with "Add a sample
// site" and "New site" for editors.
import { TwinSitesList, type TwinSiteRow } from "@/components/twin/TwinSitesList";
import { requireOpsViewer } from "@/lib/ops/page-guard";
import { requireWorkspaceRole } from "@/lib/authz";
import { listSites } from "@/lib/twin/state";
import { PlanFeatureNotice } from "@/components/billing/PlanFeatureNotice";

export const dynamic = "force-dynamic";

export const metadata = { title: "Digital twin — ShapesOS", description: "Warehouses, factories and stores as live 3D sites." };

export default async function Page() {
  const { userId, workspaceId } = await requireOpsViewer();
  const canEdit = !!(await requireWorkspaceRole(userId, workspaceId, "editor"));
  // Sample sites write many records at once: the sample route is admin+.
  const canAddSample = !!(await requireWorkspaceRole(userId, workspaceId, "admin"));
  let sites: TwinSiteRow[] = [];
  let loadError: string | null = null;
  try {
    sites = await listSites(workspaceId);
  } catch (err) {
    console.error("[twin] listSites failed", err);
    loadError = "The sites couldn't be loaded. Reload to try again.";
  }
  // Drafts are for the people who can edit them.
  const visible = canEdit ? sites : sites.filter((s) => s.status === "published");
  const list = <TwinSitesList sites={visible} canEdit={canEdit} canAddSample={canAddSample} loadError={loadError} />;
  // Phase 15.3 (pricing): the digital twin is Pro and up, with a per-plan
  // site count (Pro 3). Renders nothing on self-hosted, trial and Business.
  const notice = canEdit
    ? await PlanFeatureNotice({ workspaceId, userId, feature: "digital_twin", limit: { key: "twin_sites", used: sites.length } })
    : null;
  if (!notice) return list;
  return (
    <div className="flex flex-col gap-4">
      {notice}
      {list}
    </div>
  );
}
