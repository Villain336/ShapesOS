// ShapesOS — Social (Phase 4b: media posts, approvals, calendar, engagement).
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { SocialApp } from "./SocialApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Social — ShapesOS",
  description: "Compose posts with images and video, approve them, publish through Postiz and see engagement come back.",
};

export default async function SocialPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Social</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          Write once with images or video, get it approved, publish to every connected channel. Links are tagged so results show up in
          Attribution.
        </p>
      </div>
      <Suspense fallback={<p className="text-[0.8125rem] text-muted">Loading…</p>}>
        <SocialApp canEdit={roleAtLeast(membership.role, "editor")} />
      </Suspense>
    </div>
  );
}
