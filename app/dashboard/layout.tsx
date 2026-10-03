// Marketr — authenticated dashboard shell. Every route under /dashboard
// requires a session; unauthenticated visitors bounce to /login.

import { redirect } from "next/navigation";
import {
  getAccessibleWorkspaces,
  getOrCreateWorkspace,
  requireUser,
} from "@/lib/session";
import { INVITE_REQUIRED_PATH, InviteRequiredError } from "@/lib/auth/signup";
import { AppSidebar, MobileNav, type SidebarBadges } from "@/components/AppSidebar";
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
// Phase 13 Wave A (theming): tenant-scoped brand theme root.
import { BrandTheme } from "@/components/BrandTheme";
import { sanitizeBrandHex } from "@/lib/brand-theme";
import { prisma } from "@/lib/prisma";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");

  // SIGNUP_MODE=invite: a signed-in user with no workspace (e.g. an invitee
  // who hasn't opened their invite link yet) is not auto-provisioned.
  const workspace = await getOrCreateWorkspace(user.id, user.email).catch((err: unknown) => {
    if (err instanceof InviteRequiredError) redirect(INVITE_REQUIRED_PATH);
    throw err;
  });
  const workspaces = await getAccessibleWorkspaces(user.id);

  // Live count pills next to nav rows (see SidebarBadges). `needs-you` is
  // the Approvals badge slot: mount components/approvals/NeedsYouBadge here,
  // e.g. { "needs-you": <NeedsYouBadge /> }. Until that component ships the
  // slot stays empty and the sidebar renders no pill.
  const sidebarBadges: SidebarBadges = {};

  const sidebarProps = {
    user: { name: user.name, email: user.email },
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
    currentWorkspaceId: workspace.id,
    badges: sidebarBadges,
  };

  // Phase 12 (embeds): Chatwoot widget config resolved server-side; the
  // widget mounts only when the operator explicitly opted in.
  const chatwoot = chatwootWidgetConfig();
  // Phase 12 (embeds): GrowthBook public SDK config (client key is public
  // by design; the Admin API key never leaves the server).
  const gbConfig = growthBookSdkConfig();

  // Phase 13 Wave A (theming): the workspace's DEFAULT brand kit drives the
  // primary accent. Null = the Agentic OS default: black primary actions
  // (globals.css :root maps --brand-600/700 to black). Scoped to the
  // BrandTheme root below so it can never leak across workspaces.
  const defaultKit = await prisma.brandKit.findFirst({
    where: { workspaceId: workspace.id, isDefault: true },
    select: { colors: true },
  });
  const brandPrimary = sanitizeBrandHex(
    (defaultKit?.colors as Record<string, string> | null)?.primary,
  );

  return (
    <BrandTheme primary={brandPrimary}>
      <ChatProvider>
        <CommandBar workspaceId={workspace.id} />
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
    </BrandTheme>
  );
}
