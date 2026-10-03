// Marketr — Flywheel command center (Phase 7 root, docs/specs/SPEC-PHASE7.md §6).
//
// Six-track overview: reallocation agent (F1), creative recycling (F2),
// Test Lab (F3), CTV buying path (F4), DSP readiness (F5), launch readiness
// (F6). Cards deep-link into each track's page. Money invariant lives in the
// subtitle — autopilot never buys media; every dollar stays human-signed.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";

// Neutral category chip. Pending approvals awaiting attention use the needs tone.
const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-[11px] font-semibold leading-tight text-muted shadow-control";
const chipNeeds =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-needs px-2 py-0.5 text-[11px] font-semibold leading-tight text-ink";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Flywheel — ShapesOS",
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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="aos-heading">Flywheel</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
            Reallocate budget to what works, recycle winning creative, test honestly, and expand
            channels — on rails that keep every dollar human-signed. Autopilot never buys media.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <span className={pendingApprovals > 0 ? chipNeeds : chip}>
              {pendingApprovals > 0 && (
                <span className="aos-shape aos-shape--needs aos-shape--edged [--aos-shape-size:10px]" style={{ color: "inherit" }} aria-hidden />
              )}
            {pendingApprovals} pending approvals
          </span>
          <span className={chip}>
            {activeSras} active SRAs
          </span>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-xl border border-line bg-white p-5 transition hover:bg-hover-paper"
          >
            <h2 className="text-base font-semibold text-ink">{c.title}</h2>
            <p className="mt-1 text-sm text-muted">{c.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
