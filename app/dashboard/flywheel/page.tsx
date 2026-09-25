// Marketr — Flywheel command center (Phase 7 root, SPEC-PHASE7.md §6).
//
// Six-track overview: reallocation agent (F1), creative recycling (F2),
// Test Lab (F3), CTV buying path (F4), DSP readiness (F5), launch readiness
// (F6). Cards deep-link into each track's page. Money invariant banner:
// autopilot never buys media; every dollar stays human-signed.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { Badge } from "@/components/vault/shadcn/badge";
import {
  Scale,
  Recycle,
  FlaskConical,
  Tv,
  Network,
  Rocket,
  ShieldCheck,
  ArrowRight,
} from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Flywheel — Marketr",
  description: "Phase 7 flywheel command center: reallocation, creative recycling, Test Lab, CTV, DSP readiness, launch readiness.",
};

interface TrackCard {
  href: string;
  icon: typeof Scale;
  title: string;
  tag: string;
  tagVariant: "default" | "secondary" | "outline";
  blurb: string;
  stat: string;
}

async function trackStats(workspaceId: string): Promise<Record<string, string>> {
  const stats: Record<string, string> = {};
  try {
    const { createPrismaReallocationStore } = await import("@/lib/flywheel/reallocation/store");
    const { prisma } = await import("@/lib/prisma");
    const store = createPrismaReallocationStore(prisma);
    const [proposals, sras] = await Promise.all([
      store.listProposals(workspaceId, 100).catch(() => []),
      store.listSras(workspaceId).catch(() => []),
    ]);
    const pending = proposals.filter((p) => p.status === "proposed").length;
    const activeSra = sras.filter((s) => s.status === "active").length;
    stats.reallocation = `${pending} awaiting approval · ${activeSra} active SRA${activeSra === 1 ? "" : "s"}`;
  } catch {
    stats.reallocation = "tables not provisioned";
  }
  try {
    const { resolveExperimentStore } = await import("@/lib/flywheel/testlab/store");
    const { store } = await resolveExperimentStore();
    const tests = await store.listExperiments(workspaceId).catch(() => []);
    const running = tests.filter((t) => t.status === "running").length;
    stats.testlab = `${running} running · ${tests.length} total`;
  } catch {
    stats.testlab = "tables not provisioned";
  }
  try {
    const { getCtvStore } = await import("@/lib/flywheel/ctv/store");
    const campaigns = await getCtvStore().listCampaigns(workspaceId).catch(() => []);
    stats.ctv = `${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`;
  } catch {
    stats.ctv = "tables not provisioned";
  }
  try {
    const { listLaunchChecklist, progressOf, seedLaunchChecklist } = await import("@/lib/flywheel/launch/store");
    await seedLaunchChecklist(workspaceId).catch(() => {});
    const items = await listLaunchChecklist(workspaceId).catch(() => []);
    const prog = progressOf(items);
    const pct = prog.total ? Math.round((prog.complete / prog.total) * 100) : 0;
    stats.launch = `${pct}% ready`;
  } catch {
    stats.launch = "tables not provisioned";
  }
  return stats;
}

export default async function FlywheelPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const stats = await trackStats(workspace.id);

  const tracks: TrackCard[] = [
    {
      href: "/dashboard/flywheel/reallocation",
      icon: Scale,
      title: "Budget reallocation",
      tag: "F1",
      tagVariant: "default",
      blurb:
        "Marginal-ROAS equalization across channels on diminishing-returns curves. Propose-only by default; bounded execution only inside a human-signed, expiring Standing Reallocation Approval.",
      stat: stats.reallocation ?? "—",
    },
    {
      href: "/dashboard/flywheel/recycling",
      icon: Recycle,
      title: "Creative recycling",
      tag: "F2",
      tagVariant: "secondary",
      blurb:
        "Turn winning creative into channel-specific variants. Creative-hash lineage stays intact; every variant re-enters approval and buying flows. Nothing auto-publishes.",
      stat: "variant briefs + approvals",
    },
    {
      href: "/dashboard/flywheel/tests",
      icon: FlaskConical,
      title: "Test Lab",
      tag: "F3",
      tagVariant: "secondary",
      blurb:
        "Experimentation with an honesty contract: Bayesian/sequential analysis, SRM hard gate, frequentist backstop. Underpowered tests are refused or labeled inconclusive — never shipped as wins.",
      stat: stats.testlab ?? "—",
    },
    {
      href: "/dashboard/flywheel/ctv",
      icon: Tv,
      title: "CTV buying path",
      tag: "F4",
      tagVariant: "outline",
      blurb:
        "Streaming commercials: Vibe adapter (CRUD + pause + reporting; budget changes route through F1) and concierge workflow for MNTN, Roku, Tatari, and tvScientific. No deterministic ROAS is ever claimed.",
      stat: stats.ctv ?? "—",
    },
    {
      href: "/dashboard/flywheel/dsp",
      icon: Network,
      title: "DSP readiness",
      tag: "F5",
      tagVariant: "outline",
      blurb:
        "No DSP seat in v1. Adapter interfaces, fee schedules, distinct margin accounting, cap/pause mappings, and spend-volume tripwires — contracts and billing stay with the client.",
      stat: "interfaces + tripwires",
    },
    {
      href: "/dashboard/flywheel/launch",
      icon: Rocket,
      title: "Launch readiness",
      tag: "F6",
      tagVariant: "outline",
      blurb:
        "Public-launch readiness tracker: security, legal, community, build. Readiness only — the open-core split decision stays deferred, and no public flip is part of this phase.",
      stat: stats.launch ?? "—",
    },
  ];

  return (
    <div className="flex h-full flex-col gap-6 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight text-stone-900">Flywheel</h1>
          <Badge variant="default">Phase 7</Badge>
        </div>
        <p className="mt-0.5 max-w-3xl text-[13px] text-stone-500">
          The growth flywheel: reallocate budget to what works, recycle winning creative, test
          honestly, and expand channels — on rails that keep every dollar human-signed.
        </p>
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[13px] text-emerald-900">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Money invariant: autopilot never buys media. Proposals need per-move approval, or a
            bounded, expiring, instantly-revocable Standing Reallocation Approval. Breakers can only
            freeze or pause — never spend.
          </span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {tracks.map((t) => (
          <Link key={t.href} href={t.href} className="group">
            <Card className="flex h-full flex-col transition-shadow group-hover:shadow-md">
              <CardHeader
                title={
                  <span className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-stone-900 text-stone-50">
                      <t.icon className="h-4 w-4" />
                    </span>
                    {t.title}
                  </span>
                }
                actions={<Badge variant={t.tagVariant}>{t.tag}</Badge>}
              />
              <CardBody className="flex flex-1 flex-col gap-3">
                <p className="flex-1 text-[13px] leading-relaxed text-stone-600">{t.blurb}</p>
                <div className="flex items-center justify-between border-t border-stone-100 pt-3">
                  <span className="text-xs text-stone-500">{t.stat}</span>
                  <span className="flex items-center gap-1 text-xs font-medium text-stone-700 group-hover:text-stone-950">
                    Open <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </div>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
