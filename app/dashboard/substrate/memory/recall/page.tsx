// Marketr — Phase 8 G3: recall playground page.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import RecallClient from "./recall-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Recall playground — Growth Memory — ShapesOS",
  description: "Query the hybrid lexical+vector memory with provenance and freshness.",
};

export default async function RecallPage() {
  const user = await requireUser();
  if (!user?.id) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  return <RecallClient workspaceId={workspace.id} />;
}
