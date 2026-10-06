// ShapesOS — Phase 18.3 (WS=trust): Settings → Privacy and security → Data
// access log. Which agent read which app's data in this workspace, and when.
// Admin+. Derived from the runs' own tool steps and the ops read log.

import { BLOCKABLE_GROUPS } from "@/lib/agents/grants";
import { loadDataAccess } from "@/lib/privacy/data-access";
import { DataAccessTable } from "@/components/trust/DataAccessTable";
import { CenterFrame, centerContext } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Data access log — ShapesOS" };

export default async function DataAccessLogPage() {
  const ctx = await centerContext("admin");
  const { t } = ctx.i18n;
  const rows = await loadDataAccess({ workspaceId: ctx.workspaceId }).catch(() => []);
  return (
    <CenterFrame title={t("trust.dataAccess.title")} subtitle={t("trust.dataAccess.subtitle", { workspace: ctx.workspaceName })}>
      <DataAccessTable scope="workspace" initial={rows} groups={["workspace", ...BLOCKABLE_GROUPS]} />
      <p className="text-sm text-muted">{t("trust.dataAccess.note")}</p>
    </CenterFrame>
  );
}
