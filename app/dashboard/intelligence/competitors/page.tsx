// Marketr — Phase 10 M4: Competitor change fleet UI.
// Dense change table (competitor, change-type badge, semantic summary,
// recommended response, status) + watchlist management + weekly digest view
// + licensed review-velocity pulls. House style per StudioApp.tsx
// (diffed class-by-class): bg-canvas shell, text-xl bold title, Lucide
// sub-tabs (ACTIVE = border-ink text-ink), dense tables with
// badge columns and rows hover:bg-hover-paper, filter toolbar = dropdowns +
// search + violet button, info notes border-line bg-canvas.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { CompetitorsClient } from "./CompetitorsClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Competitor change fleet — Marketr",
  description:
    "Semantic competitor intelligence: what changed on competitor sites, why it matters for your tracked keywords, and the proposed response.",
};

export default async function CompetitorsPage() {
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
        <h1 className="aos-heading">
          Competitor change fleet
        </h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
          Semantic competitor intelligence — what changed, why it matters for
          your tracked keywords, and the proposed response. Polite, robots-
          respecting self-fetch only; reviews via licensed APIs only.
        </p>
      </div>
      <CompetitorsClient projects={projects} />
    </div>
  );
}
