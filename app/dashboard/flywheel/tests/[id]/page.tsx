// Marketr — Test Lab experiment detail: lifecycle, QA, honesty dashboard.
// Mirrors app/dashboard/authority conventions (server page + client actions).

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
import { Badge } from "@/components/vault/shadcn/badge";
import { ArrowLeft, ShieldAlert, ShieldCheck, Gauge, CalendarClock } from "lucide-react";
import { TestLabActions } from "./_components/TestLabActions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Experiment — Test Lab — Marketr",
};

function statusVariant(s: string) {
  switch (s) {
    case "running": return "default";
    case "complete": return "secondary";
    case "qa": return "outline";
    default: return "secondary";
  }
}

export default async function ExperimentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canEdit = ["owner", "admin", "editor"].includes(membership.role);

  const { id } = await params;
  const { store } = await resolveExperimentStore();
  const experiment = await store.getExperiment(workspace.id, id).catch(() => null);
  if (!experiment) redirect("/dashboard/flywheel/tests");
  const result = await store.getResult(id).catch(() => null);
  const stats = (result?.statsJson ?? {}) as Record<string, unknown>;
  const badges = (stats.badges ?? null) as {
    power: { label: string; detail: string };
    maturity: { label: string; detail: string };
    integrity: { label: string; detail: string };
  } | null;

  return (
    <div className="space-y-6">
      <Link href="/dashboard/flywheel/tests" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Test Lab
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{experiment.name}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{experiment.hypothesis}</p>
        </div>
        <div className="flex gap-2">
          <Badge variant={statusVariant(experiment.status)}>{experiment.status}</Badge>
          {experiment.verdict && (
            <Badge variant={experiment.verdict === "winner" ? "default" : "secondary"}>
              {experiment.verdict}
            </Badge>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">Channel</p>
          <p className="mt-1 font-semibold">{experiment.channel}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">Primary metric</p>
          <p className="mt-1 font-semibold">{experiment.primaryMetric}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">Stated MDE</p>
          <p className="mt-1 font-semibold">{(experiment.statedMde * 100).toFixed(1)}% lift</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground">Min runtime</p>
          <p className="mt-1 font-semibold">{experiment.minRuntimeDays} days</p>
        </div>
      </div>

      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-base font-semibold">Variants</h2>
        <div className="mt-3 space-y-2">
          {experiment.variants.map((v) => (
            <div key={v.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
              <div>
                <span className="font-medium">{v.name}</span>
                {v.description && <span className="ml-2 text-muted-foreground">{v.description}</span>}
              </div>
              <Badge variant="outline">{(v.weight * 100).toFixed(0)}%</Badge>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Guardrails: {experiment.guardrailMetrics.length > 0
            ? experiment.guardrailMetrics.map((g) => `${g.name} (±${(g.tolerance * 100).toFixed(0)}%)`).join(", ")
            : "none declared"}
          {" · "}Profit guardrail: {experiment.profitGuardrail ? "declared" : "not declared"}
        </p>
        {experiment.trafficFloorNote && (
          <p className="mt-2 rounded-lg bg-muted p-3 text-xs">{experiment.trafficFloorNote}</p>
        )}
      </section>

      {badges && (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-base font-semibold">Honesty dashboard</h2>
          <p className="mt-2 text-lg font-medium">{String(stats.headline ?? "")}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border p-3">
              <p className="flex items-center gap-1 text-xs font-medium"><Gauge className="h-3 w-3" /> Power</p>
              <Badge variant={badges.power.label === "powered" ? "default" : "destructive"} className="mt-1">
                {badges.power.label}
              </Badge>
              <p className="mt-1 text-xs text-muted-foreground">{badges.power.detail}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="flex items-center gap-1 text-xs font-medium"><CalendarClock className="h-3 w-3" /> Maturity</p>
              <Badge variant={badges.maturity.label === "mature" ? "default" : "outline"} className="mt-1">
                {badges.maturity.label}
              </Badge>
              <p className="mt-1 text-xs text-muted-foreground">{badges.maturity.detail}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="flex items-center gap-1 text-xs font-medium">
                {badges.integrity.label === "clean"
                  ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />} Integrity
              </p>
              <Badge variant={badges.integrity.label === "clean" ? "default" : "destructive"} className="mt-1">
                {badges.integrity.label}
              </Badge>
              <p className="mt-1 text-xs text-muted-foreground">{badges.integrity.detail}</p>
            </div>
          </div>
          {Array.isArray(stats.guidance) && stats.guidance.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {(stats.guidance as string[]).map((g, i) => <li key={i}>{g}</li>)}
            </ul>
          )}
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><p className="text-xs text-muted-foreground">Chance to beat</p><p className="font-semibold">{(Number(stats.prob_to_beat ?? 0) * 100).toFixed(1)}%</p></div>
            <div><p className="text-xs text-muted-foreground">Expected uplift</p><p className="font-semibold">{(Number(stats.expected_uplift ?? 0) * 100).toFixed(1)}%</p></div>
            <div><p className="text-xs text-muted-foreground">Expected loss</p><p className="font-semibold">{(Number(stats.expected_loss ?? 0) * 100).toFixed(2)}%</p></div>
            <div><p className="text-xs text-muted-foreground">Frequentist p (backstop)</p><p className="font-semibold">{Number(stats.frequentist_p ?? 1).toFixed(4)}</p></div>
          </div>
        </section>
      )}

      {canEdit && <TestLabActions experiment={experiment} />}

      {experiment.qaReport && (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-base font-semibold">QA report</h2>
          <div className="mt-3 space-y-2">
            {experiment.qaReport.checks.map((c) => (
              <div key={c.name} className="flex items-start gap-2 text-sm">
                <Badge variant={c.passed ? "default" : "destructive"}>{c.passed ? "pass" : "fail"}</Badge>
                <div><p className="font-medium">{c.name}</p><p className="text-muted-foreground">{c.detail}</p></div>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <p className="text-sm font-medium">Force-QA links</p>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {Object.entries(experiment.qaReport.forceQaLinks).map(([vid, url]) => (
                <li key={vid}><span className="font-mono">{vid}</span>: <span className="break-all">{url}</span></li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Cookie preview: <span className="font-mono">{experiment.qaReport.cookiePreview.cookieName}={experiment.qaReport.cookiePreview.cookieValue}</span>
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
