// Marketr — Knowledge Brain (server page).
// The visual corpus: every M9 source as a node in a light, futuristic
// neural graph, plus real corpus management (propose / flag / rebuild).
// House style per StudioApp.tsx (diffed class-by-class).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { BrainClient } from "./BrainClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Knowledge Brain — Marketr",
  description:
    "The visual expert corpus: every source Marketr learns from as a living neural graph. Explore, propose, and rebuild.",
};

export default async function BrainPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canManage = ["owner", "admin", "editor"].includes(membership.role);

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Knowledge Brain</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-stone-500">
          Every source the agents learn from, as a living 3D neural brain. Drag to rotate,
          click a neuron to inspect what it taught Marketr — search to fly to a source, and
          propose new sources or rebuild the corpus from here.
        </p>
      </div>
      <BrainClient canManage={canManage} />
    </div>
  );
}
