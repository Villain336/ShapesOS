// Marketr — Authority & relevance command center (Phase 6).
// Outreach health, PR pipeline, listing sync status, AEO per-engine trend,
// review queue depth, report status. Nothing publishes without approval.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { authorityTablesReady } from "@/lib/authority/db";

const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight";
const chipSlate = `${chip} bg-paper text-muted border-line`;
const chipRed = `${chip} bg-failed-tint text-failed-text border-failed`;

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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="aos-heading">Authority &amp; relevance</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
            Outreach, PR, listings, AEO, and reviews — every external action is approval-bound.
          </p>
        </div>
        <div className="flex gap-2">
          <span className={pendingApprovals > 0 ? chipRed : chipSlate}>
            {pendingApprovals} pending approvals
          </span>
          <span className={chipSlate}>
            {reviewQueueDepth} reviews in queue
          </span>
        </div>
      </div>
      {!ready && (
        <div className="rounded-lg border border-needs bg-needs-tint p-4 text-sm">
          Authority tables are not provisioned yet (migration pending).
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-lg border border-line bg-paper p-5 transition hover:border-line"
          >
            <h2 className="text-base font-semibold text-ink">{c.title}</h2>
            <p className="mt-1 text-sm text-muted">{c.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
