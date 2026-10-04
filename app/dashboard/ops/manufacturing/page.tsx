// ShapesOS Phase 12 (mfgpos) — /dashboard/ops/manufacturing: manufacturing
// orders, work orders, work centres, routings (CAD BOM) and scrap.
import { ManufacturingWorkspace } from "@/components/ops/ManufacturingViews";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Manufacturing — ShapesOS", description: "Manufacturing orders, work orders, work centres, routings and scrap." };

export default async function Page() {
  await requireOpsViewer();
  return <ManufacturingWorkspace />;
}
