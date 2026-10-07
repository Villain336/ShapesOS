// ShapesOS — Phase 18.3 (WS=trust): Settings → Privacy and security → Agent
// app access. The macOS "Allow … to access Mail?" for agents: which apps
// (tool groups) agents may use in this workspace. Members can see it; admins
// and owners change it (PUT /api/trust/agent-apps, audited).

import { roleAtLeast } from "@/lib/authz";
import { BLOCKABLE_GROUPS } from "@/lib/agents/grants";
import { getAgentBlockedGroups } from "@/lib/agents/app-permissions";
import { AgentAppsForm } from "@/components/trust/AgentAppsForm";
import { CenterFrame, centerContext } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent app access — ShapesOS" };

export default async function AgentAppAccessPage() {
  const ctx = await centerContext("viewer");
  const { t } = ctx.i18n;
  const blocked = await getAgentBlockedGroups(ctx.workspaceId, { fresh: true });
  return (
    <CenterFrame title={t("trust.apps.title")} subtitle={t("trust.apps.subtitle", { workspace: ctx.workspaceName })} wide={false}>
      <AgentAppsForm initialBlocked={blocked} blockable={[...BLOCKABLE_GROUPS]} canEdit={roleAtLeast(ctx.role, "admin")} />
    </CenterFrame>
  );
}
