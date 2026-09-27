// Marketr — Social publishing workspace (Phase 12, Postiz sidecar).
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { SocialApp } from "./SocialApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Social — Marketr",
  description: "Social publishing: compose, schedule, and publish posts across channels via the Postiz sidecar.",
};

export default async function SocialPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Social</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Compose once, publish to every connected channel — scheduling and delivery run in the
          self-hosted Postiz sidecar (raw REST, never its SDK). Platform OAuth stays inside Postiz.
        </p>
      </div>
      <SocialApp />
    </div>
  );
}
