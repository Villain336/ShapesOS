// Marketr — Phase 8 G1: connectors page (server wrapper).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import ConnectorsClient from "./connectors-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Connectors — Business Graph",
  description: "Webhook and scheduled-pull connectors feeding the business graph.",
};

export default async function ConnectorsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  return <ConnectorsClient workspaceId={workspace.id} />;
}
