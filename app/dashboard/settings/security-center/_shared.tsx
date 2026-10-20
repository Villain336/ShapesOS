// ShapesOS — Phase 18.3 (WS=trust): shared frame for the Privacy & Security
// center (Settings → Privacy and security). Admin+ by default (the audit
// timeline, data access log and memory controls cover the whole workspace);
// a member without the role is sent to the dashboard, like the Audit log.

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { WorkspaceRole } from "@prisma/client";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import { getI18n, type ServerI18n } from "@/lib/i18n/server";

export interface CenterContext {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  i18n: ServerI18n;
}

export async function centerContext(min: WorkspaceRole = "admin"): Promise<CenterContext> {
  const user = await requireUser();
  if (!user?.id) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, min);
  if (!membership) redirect("/dashboard");
  return { userId: user.id, workspaceId: workspace.id, workspaceName: workspace.name, role: membership.role, i18n: await getI18n() };
}

export function CenterFrame({ title, subtitle, children, wide = true }: { title: string; subtitle: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">{title}</h1>
        <p className="mt-0.5 text-sm text-muted">{subtitle}</p>
      </div>
      <SettingsNav />
      <div className={`flex flex-col gap-4 ${wide ? "" : "max-w-3xl"}`}>{children}</div>
    </div>
  );
}
