// Marketr — Authority & relevance command center (Phase 6).
// Outreach health, PR pipeline, listing sync status, AEO per-engine trend,
// review queue depth, report status. Nothing publishes without approval.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { authorityTablesReady } from "@/lib/authority/db";
import { Badge } from "@/components/vault/shadcn/badge";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Authority — Marketr",
  description: "Authority & relevance command center: outreach, PR, listings, AEO, reviews.",
};

const CARDS = [
  { href: "/dashboard/authority/outreach", title: "Outreach", desc: "Guest-post campaigns on the 3-depth ladder, deliverability health." },
  { href: "/dashboard/authority/pr", title: "Digital PR", desc: "Journalist queries, draft workspace, placements. Humans send." },
  { href: "/dashboard/authority/listings", title: "Listings", desc: "GBP, Bing, LDE prototype, Apple claims, citation briefs — honestly tiered." },
  { href: "/dashboard/authority/aeo", title: "AEO", desc: "Per-engine AI visibility, source impact, approval-gated actions." },
  { href: "/dashboard/authority/reviews", title: "Reviews", desc: "Reply approval queue, moderation-state tracking, velocity." },
  { href: "/dashboard/authority/intelligence", title: "Intelligence", desc: "Twelve audits → revenue opportunities → 90-day Growth Plan." },
];

export default async function AuthorityPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const ready = await authorityTablesReady().catch(() => false);
  let pendingApprovals = 0;
  let reviewQueueDepth = 0;
  if (ready) {
    [pendingApprovals, reviewQueueDepth] = await Promise.all([
      prisma.authorityApproval.count({ where: { workspaceId: workspace.id, status: "pending" } }).catch(() => 0),
      prisma.reviewQueue.count({ where: { workspaceId: workspace.id, status: "pending" } }).catch(() => 0),
    ]);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Authority &amp; relevance</h1>
          <p className="text-sm text-muted-foreground">
            Outreach, PR, listings, AEO, and reviews — every external action is approval-bound.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant={pendingApprovals > 0 ? "destructive" : "secondary"}>
            {pendingApprovals} pending approvals
          </Badge>
          <Badge variant={reviewQueueDepth > 0 ? "outline" : "secondary"}>
            {reviewQueueDepth} reviews in queue
          </Badge>
        </div>
      </div>
      {!ready && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          Authority tables are not provisioned yet (migration pending).
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-xl border bg-card p-5 shadow-sm transition hover:shadow-md"
          >
            <h2 className="text-base font-semibold">{c.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{c.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
