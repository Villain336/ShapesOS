// ShapesOS Phase 12 (mfgpos) — /dashboard/ops/pos: registers, till sessions
// (open with a float, count, close) and the way into the touch till.
import { PosWorkspace } from "@/components/ops/PosViews";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Point of sale — ShapesOS", description: "Registers, till sessions and the touch-screen till." };

export default async function Page() {
  await requireOpsViewer();
  return <PosWorkspace />;
}
