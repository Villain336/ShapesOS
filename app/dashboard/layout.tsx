// Marketr — authenticated dashboard shell. Every route under /dashboard
// requires a session; unauthenticated visitors bounce to /login.

import { redirect } from "next/navigation";
import {
  getAccessibleWorkspaces,
  getOrCreateWorkspace,
  requireUser,
} from "@/lib/session";
import { INVITE_REQUIRED_PATH, InviteRequiredError } from "@/lib/auth/signup";
import { TWO_FACTOR_SETUP_PATH } from "@/lib/auth/mfa/policy";
import { AppSidebar, MobileNav } from "@/components/AppSidebar";
import { DashboardMain } from "@/components/DashboardMain";
// Phase 3 (J): desktop header — "needs you" shortcut + notification bell.
import { AppTopBar } from "@/components/AppTopBar";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { ChatProvider } from "@/components/chat/ChatContext";
import { CommandBar } from "@/components/command-bar/CommandBar";
// Phase 4d: New task composer (sidebar pill, Overview, ⌘K, ⌘N).
import { NewTaskDialog } from "@/components/command-bar/NewTaskDialog";
// Shared confirm dialog + toast stack (lib/ui/feedback.ts).
import { FeedbackHost } from "@/components/feedback/FeedbackHost";
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
// Phase 3: hosted trial notice + billing reachable from the sidebar.
import { getMembership, roleAtLeast } from "@/lib/authz";
import { trialView } from "@/lib/billing/trial";
import { TrialBanner } from "@/components/workspace/TrialBanner";
import { planHasFeature } from "@/lib/billing/entitlements";
// Phase 4d: sidebar "Running now" (lead agent → sub-agents) + usage meter.
import { safeAgentActivity, safeUsageMeter } from "@/lib/aos/activity.server";

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
  // Phase 4a: the workspace requires a second factor and this session hasn't
  // passed one → set one up first (lib/auth/mfa/policy.ts).
  if (workspace.requireTwoFactor && !user.twoFactor) redirect(TWO_FACTOR_SETUP_PATH);
  const [workspaces, membership, activity, usage] = await Promise.all([
    getAccessibleWorkspaces(user.id),
    getMembership(user.id, workspace.id),
    safeAgentActivity(workspace.id),
    safeUsageMeter(workspace.id),
  ]);
  const isAdmin = roleAtLeast(membership?.role, "admin");
  const trial = trialView(workspace);

  const sidebarProps = {
    user: { name: user.name, email: user.email },
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
    currentWorkspaceId: workspace.id,
    canManageBilling: isAdmin,
    plan: workspace.plan,
    // The needs-you count and this tree refresh client-side (polled).
    initialTree: activity?.tree ? { lead: activity.tree.lead, branches: activity.tree.branches } : null,
    initialUsage: usage,
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
  // Phase 4a: re-tinting the dashboard is the custom_branding entitlement;
  // plans without it keep the Agentic OS default.
  const defaultKit = planHasFeature(workspace.plan, "custom_branding")
    ? await prisma.brandKit.findFirst({
        where: { workspaceId: workspace.id, isDefault: true },
        select: { colors: true },
      })
    : null;
  const brandPrimary = sanitizeBrandHex(
    (defaultKit?.colors as Record<string, string> | null)?.primary,
  );

  return (
    <BrandTheme primary={brandPrimary}>
      <ChatProvider>
        <CommandBar workspaceId={workspace.id} />
        <NewTaskDialog />
        <FeedbackHost />
        {chatwoot && (
          <ChatwootWidget baseUrl={chatwoot.baseUrl} websiteToken={chatwoot.websiteToken} />
        )}
        {/* AppTopBar (bell + needs-you) is desktop-only; mobile gets the bell here. */}
        <MobileNav {...sidebarProps} headerActions={<NotificationBell />} />
        <div className="flex">
          <AppSidebar {...sidebarProps} />
          <div className="min-w-0 flex-1">
            <AppTopBar />
            <GrowthBookProvider config={gbConfig}>
              <DashboardMain
                banner={trial ? <TrialBanner trial={trial} canManageBilling={isAdmin} /> : null}
              >
                {children}
              </DashboardMain>
            </GrowthBookProvider>
          </div>
        </div>
      </ChatProvider>
    </BrandTheme>
  );
}
