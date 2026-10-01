// Marketr — Phase 10 M1: Rank intelligence (GSC-first).
// GSC-sourced visibility tables (query × page × delta) with before/after
// windows, winners/losers, rows badged by source (GSC vs paid vendor).
// House style per StudioApp.tsx (diffed class-by-class).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { RankClient } from "./RankClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Rank intelligence — Marketr",
  description:
    "GSC-sourced rank truth for owned sites: query × page deltas, winners/losers, and visibility score from before/after windows.",
};

export default async function RankPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, domain: true },
  });

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Rank intelligence</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
          GSC is the rank truth for owned sites — deltas, winners/losers, and the
          visibility score recomputed from Search Analytics. Paid SERP only covers
          what GSC cannot see.
        </p>
      </div>
      <RankClient projects={projects} />
    </div>
  );
}
