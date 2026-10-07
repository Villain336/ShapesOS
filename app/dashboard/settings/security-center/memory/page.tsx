// ShapesOS — Phase 18.3 (WS=trust): Settings → Privacy and security → Memory
// controls. What agents remember about the workspace — episodes, facts,
// lessons, company knowledge — with a real "forget". Admin+.

import { listMemory } from "@/lib/privacy/memory";
import { MemoryControls } from "@/components/trust/MemoryControls";
import { CenterFrame, centerContext } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Memory controls — ShapesOS" };

export default async function MemoryControlsPage() {
  const ctx = await centerContext("admin");
  const { t } = ctx.i18n;
  const items = await listMemory({ workspaceId: ctx.workspaceId, store: "episode" }).catch(() => []);
  return (
    <CenterFrame title={t("trust.memory.title")} subtitle={t("trust.memory.subtitle", { workspace: ctx.workspaceName })}>
      <MemoryControls scope="workspace" initial={items} />
    </CenterFrame>
  );
}
