// ShapesOS Phase 12 (mfgpos) — /dashboard/ops/pos: registers, till sessions
// (open with a float, count, close) and the way into the touch till.
import { PosWorkspace } from "@/components/ops/PosViews";
import { requireOpsViewer } from "@/lib/ops/page-guard";
import { PlanFeatureNotice } from "@/components/billing/PlanFeatureNotice";

export const dynamic = "force-dynamic";

export const metadata = { title: "Point of sale — ShapesOS", description: "Registers, till sessions and the touch-screen till." };

export default async function Page() {
  const { userId, workspaceId } = await requireOpsViewer();
  // Phase 15.3 (pricing): explains the POS gate on plans without it (renders
  // nothing on Pro and up, trial and self-hosted).
  const notice = await PlanFeatureNotice({ workspaceId, userId, feature: "pos" });
  if (!notice) return <PosWorkspace />;
  return (
    <div className="flex flex-col gap-4">
      {notice}
      <PosWorkspace />
    </div>
  );
}
