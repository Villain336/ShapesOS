// Marketr — Flywheel command center (Phase 7 root, SPEC-PHASE7.md §6).
//
// Six-track overview: reallocation agent (F1), creative recycling (F2),
// Test Lab (F3), CTV buying path (F4), DSP readiness (F5), launch readiness
// (F6). Cards deep-link into each track's page. Money invariant lives in the
// subtitle — autopilot never buys media; every dollar stays human-signed.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { Badge } from "@/components/vault/shadcn/badge";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Flywheel — Marketr",
  description: "Phase 7 flywheel command center: reallocation, creative recycling, Test Lab, CTV, DSP readiness, launch readiness.",
};

const CARDS = [
  {
    href: "/dashboard/flywheel/reallocation",
    title: "Budget reallocation",
    desc: "Marginal-ROAS equalization across channels on diminishing-returns curves. Propose-only by default; bounded execution only inside a human-signed, expiring Standing Reallocation Approval.",
  },
  {
    href: "/dashboard/flywheel/recycling",
    title: "Creative recycling",
    desc: "Turn winning creative into channel-specific variants. Creative-hash lineage stays intact; every variant re-enters approval and buying flows. Nothing auto-publishes.",
  },
  {
    href: "/dashboard/flywheel/tests",
    title: "Test Lab",
    desc: "Experimentation with an honesty contract: Bayesian/sequential analysis, SRM hard gate, frequentist backstop. Underpowered tests are refused or labeled inconclusive — never shipped as wins.",
  },
  {
    href: "/dashboard/flywheel/ctv",
    title: "CTV buying path",
    desc: "Streaming commercials: Vibe adapter (CRUD + pause + reporting; budget changes route through the reallocation track) and concierge workflow for MNTN, Roku, Tatari, and tvScientific. No deterministic ROAS is ever claimed.",
  },
  {
    href: "/dashboard/flywheel/dsp",
    title: "DSP readiness",
    desc: "No DSP seat in v1. Adapter interfaces, fee schedules, distinct margin accounting, cap/pause mappings, and spend-volume tripwires — contracts and billing stay with the client.",
  },
  {
    href: "/dashboard/flywheel/launch",
    title: "Launch readiness",
    desc: "Public-launch readiness tracker: security, legal, community, build. Readiness only — the open-core split decision stays deferred, and no public flip is part of this phase.",
  },
];

async function trackStats(workspaceId: string): Promise<{ pendingApprovals: number; activeSras: number }> {
  let pendingApprovals = 0;
  let activeSras = 0;
  try {
    const { createPrismaReallocationStore } = await import("@/lib/flywheel/reallocation/store");
    const { prisma } = await import("@/lib/prisma");
    const store = createPrismaReallocationStore(prisma);
    const [proposals, sras] = await Promise.all([
      store.listProposals(workspaceId, 100).catch(() => []),
      store.listSras(workspaceId).catch(() => []),
    ]);
    pendingApprovals = proposals.filter((p) => p.status === "proposed").length;
    activeSras = sras.filter((s) => s.status === "active").length;
  } catch {
    // tables not provisioned — badges stay at zero
  }
  return { pendingApprovals, activeSras };
}

export default async function FlywheelPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const { pendingApprovals, activeSras } = await trackStats(workspace.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Flywheel</h1>
          <p className="text-sm text-muted-foreground">
            Reallocate budget to what works, recycle winning creative, test honestly, and expand
            channels — on rails that keep every dollar human-signed. Autopilot never buys media.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Badge variant={pendingApprovals > 0 ? "destructive" : "secondary"}>
            {pendingApprovals} pending approvals
          </Badge>
          <Badge variant={activeSras > 0 ? "outline" : "secondary"}>
            {activeSras} active SRAs
          </Badge>
        </div>
      </div>
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
