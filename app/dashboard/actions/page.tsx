// Marketr — Phase 14: Actions page shell (server).
// Tabs: Connections | Approvals queue | Activity. Follows the Studio house
// pattern (AGENTS.md): brand vars, Lucide icons, dense tables.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { listConnections } from "@/lib/integrations/actions/connections";
import { listApprovals, listActionLogs } from "@/lib/integrations/actions/gate";
import { listDirectory } from "@/lib/integrations/actions/toolkits";
import { checkBudget, getUsageByToolkit } from "@/lib/integrations/actions/budget";
import { V1_COMPOSIO_APPS } from "@/lib/integrations/actions/risk";
import { ActionsClient } from "./ActionsClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Actions — ShapesOS",
  description: "Connect apps and review agent-proposed actions. Nothing executes without your approval.",
};

export default async function ActionsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const [connections, approvals, logs, toolkits, budgetCheck, attribution] = await Promise.all([
    listConnections(workspace.id),
    listApprovals(workspace.id, { status: "all", limit: 50 }),
    listActionLogs(workspace.id, 50),
    listDirectory(workspace.id),
    checkBudget(workspace.id),
    getUsageByToolkit(workspace.id),
  ]);

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Actions</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          Connect your apps once — agents then propose real-world actions here. Reads run
          automatically; every write or destructive action waits for your approval. Nothing
          executes silently.
        </p>
      </div>
      <ActionsClient
        apps={V1_COMPOSIO_APPS}
        initialConnections={JSON.parse(JSON.stringify(connections))}
        initialApprovals={JSON.parse(JSON.stringify(approvals))}
        initialLogs={JSON.parse(JSON.stringify(logs))}
        initialToolkits={JSON.parse(JSON.stringify(toolkits))}
        initialBudget={JSON.parse(JSON.stringify(budgetCheck))}
        initialAttribution={JSON.parse(JSON.stringify(attribution))}
      />
    </div>
  );
}
