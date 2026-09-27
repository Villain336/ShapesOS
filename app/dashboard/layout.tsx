// Marketr — authenticated dashboard shell. Every route under /dashboard
// requires a session; unauthenticated visitors bounce to /login.

import { redirect } from "next/navigation";
import {
  getAccessibleWorkspaces,
  getOrCreateWorkspace,
  requireUser,
} from "@/lib/session";
import { AppSidebar, MobileNav } from "@/components/AppSidebar";
import { DashboardMain } from "@/components/DashboardMain";
import { ChatProvider } from "@/components/chat/ChatContext";
import { CommandBar } from "@/components/command-bar/CommandBar";
// Phase 12 (embeds): Chatwoot live-chat widget. Renders nothing unless the
// operator opted in via CHATWOOT_WIDGET_ENABLED=true + credentials.
import { ChatwootWidget } from "@/components/chat/ChatwootWidget";
import { chatwootWidgetConfig } from "@/lib/integrations/chatwoot";
// Phase 12 (embeds): GrowthBook SDK provider. Falls back to built-in flag
// defaults when the sidecar is unconfigured.
import { GrowthBookProvider } from "@/components/experiments/GrowthBookProvider";
import { growthBookSdkConfig } from "@/lib/integrations/growthbook";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const workspaces = await getAccessibleWorkspaces(user.id);

  const sidebarProps = {
    user: { name: user.name, email: user.email },
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
    currentWorkspaceId: workspace.id,
  };

  // Phase 12 (embeds): Chatwoot widget config resolved server-side; the
  // widget mounts only when the operator explicitly opted in.
  const chatwoot = chatwootWidgetConfig();
  // Phase 12 (embeds): GrowthBook public SDK config (client key is public
  // by design; the Admin API key never leaves the server).
  const gbConfig = growthBookSdkConfig();

  return (
    <div className="min-h-screen bg-page font-sans text-ink">
      <ChatProvider>
        <CommandBar />
        {chatwoot && (
          <ChatwootWidget baseUrl={chatwoot.baseUrl} websiteToken={chatwoot.websiteToken} />
        )}
        <MobileNav {...sidebarProps} />
        <div className="flex">
          <AppSidebar {...sidebarProps} />
          <div className="min-w-0 flex-1">
            <GrowthBookProvider config={gbConfig}>
              <DashboardMain>{children}</DashboardMain>
            </GrowthBookProvider>
          </div>
        </div>
      </ChatProvider>
    </div>
  );
}
