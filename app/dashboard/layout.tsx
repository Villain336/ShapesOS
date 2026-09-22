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

  return (
    <div className="min-h-screen bg-page font-sans text-ink">
      <ChatProvider>
        <MobileNav {...sidebarProps} />
        <div className="flex">
          <AppSidebar {...sidebarProps} />
          <div className="min-w-0 flex-1">
            <DashboardMain>{children}</DashboardMain>
          </div>
        </div>
      </ChatProvider>
    </div>
  );
}
