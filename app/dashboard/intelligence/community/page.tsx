// Marketr — community engagement page (Phase 10 M8).
// Server-gated: viewer+ (mutations are editor-guarded at the API).
// The opportunity queue reads pending community drafts from the Phase 9
// approval inbox; drafts themselves are decided there — this page links
// to it, it doesn't duplicate it.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import CommunityClient from "./CommunityClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Community engagement — ShapesOS",
  description:
    "Find live conversations where your expertise matters, draft replies, and track posted outcomes.",
};

export default async function CommunityPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Community engagement</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          {workspace.name} — draft-first outreach on HN, Reddit, and niche forums. You post
          natively; ShapesOS only drafts.
        </p>
      </div>
      <CommunityClient />
    </div>
  );
}
