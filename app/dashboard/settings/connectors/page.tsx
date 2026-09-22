// Marketr — workspace connectors settings page (milestone 21, part D1).
// Admin+ only (server-gated). Connect data sources (OAuth / API key) and
// attach custom MCP servers. Handles the OAuth callback query params.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import ConnectorsManager from "@/components/settings/ConnectorsManager";

export const dynamic = "force-dynamic";

export default async function ConnectorsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  const { connected, error } = await searchParams;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Connectors</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {workspace.name} — connect your data sources once. Credentials are
          encrypted per user and never leave the vault.
        </p>
      </div>
      <SettingsNav />
      <ConnectorsManager
        workspaceId={workspace.id}
        connectedKey={connected ?? null}
        errorMsg={error ?? null}
      />
    </div>
  );
}
