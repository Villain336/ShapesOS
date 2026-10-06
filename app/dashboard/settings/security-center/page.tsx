// ShapesOS — Phase 18.3 (WS=trust): Settings → Privacy and security →
// Security center. One audit timeline across every audit trail of the
// workspace (lib/audit-timeline — a read-side view; the Audit log page keeps
// working for the workspace log alone). Admin+.

import { loadTimeline } from "@/lib/audit-timeline/timeline.server";
import { AuditTimeline } from "@/components/trust/AuditTimeline";
import { CenterFrame, centerContext } from "./_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Security center — ShapesOS" };

export default async function SecurityCenterPage() {
  const ctx = await centerContext("admin");
  const { t } = ctx.i18n;
  const page = await loadTimeline(ctx.workspaceId).catch(() => ({ entries: [], next: null, errors: [] }));
  return (
    <CenterFrame title={t("trust.center.title")} subtitle={t("trust.center.subtitle", { workspace: ctx.workspaceName })}>
      <AuditTimeline initial={page.entries} initialNext={page.next} />
    </CenterFrame>
  );
}
