// Marketr — Phase 8 G1: ER review queue page (server wrapper).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import ErQueueClient from "./er-queue-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ER review queue — Business Graph",
  description: "Human-gated entity resolution: approve reversible merges or reject duplicates.",
};

export default async function ErQueuePage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  return <ErQueueClient workspaceId={workspace.id} />;
}
