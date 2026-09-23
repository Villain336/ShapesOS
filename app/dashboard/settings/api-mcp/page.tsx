// Marketr — API / MCP settings page (Phase C, W5). Admin+ only (server-gated).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import McpManager from "@/components/settings/McpManager";

export const dynamic = "force-dynamic";

export default async function ApiMcpSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">API / MCP</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {workspace.name} — expose this workspace to MCP clients. The MCP server is off by
          default; API keys are scoped per tool, revocable, and every call is audited.
        </p>
      </div>
      <SettingsNav />
      <McpManager />
    </div>
  );
}
