// Marketr — Test Lab experiment detail: lifecycle, QA, honesty dashboard.
// Mirrors app/dashboard/authority conventions (server page + client actions).

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
// Category chips are neutral by default (tone accepted for call-site compat).
function chip(text: React.ReactNode, cls?: string) {
  void cls;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-[0.625rem] font-semibold leading-tight text-muted shadow-control">
      {text}
    </span>
  );
}

// Status badges carry the AOS status shape language:
// running = agent run in progress, qa = awaiting attention, complete = neutral.
function statusBadge(status: string) {
  const base =
    "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[0.625rem] font-semibold leading-tight";
  if (status === "running")
    return (
      <span className={`${base} bg-running text-white`}>
        <span className="aos-shape aos-shape--running aos-is-live [--aos-shape-size:9px]" style={{ color: "inherit" }} aria-hidden /> running
      </span>
    );
  if (status === "qa")
    return (
      <span className={`${base} bg-needs text-ink`}>
        <span className="aos-shape aos-shape--needs aos-shape--edged [--aos-shape-size:9px]" style={{ color: "inherit" }} aria-hidden /> qa
      </span>
    );
  return <span className={`${base} bg-paper text-muted shadow-control`}>{status}</span>;
}

// QA outcomes: pass = neutral ink check, fail = failed-tint.
function qaChip(passed: boolean) {
  return passed ? (
    <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-ink">
      <CheckCircle2 className="h-3.5 w-3.5" /> pass
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-failed-tint px-2 py-0.5 text-[0.75rem] font-semibold text-failed-text">
      <span className="size-2 rounded-[2px] bg-failed" aria-hidden /> fail
    </span>
  );
}
import { ArrowLeft, ShieldAlert, ShieldCheck, Gauge, CalendarClock, CheckCircle2 } from "lucide-react";
import { TestLabActions } from "./_components/TestLabActions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Experiment — Test Lab — ShapesOS",
};

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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <nav className="flex items-center gap-1.5 text-xs text-muted">
        <Link href="/dashboard/flywheel/tests" className="inline-flex items-center gap-1 hover:text-ink">
          <ArrowLeft className="h-3 w-3" /> Test Lab
        </Link>
        <span>/</span>
        <span className="font-medium text-ink">{experiment.name}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="aos-heading">{experiment.name}</h1>
          <p className="mt-0.5 max-w-2xl text-[0.8125rem] text-muted">{experiment.hypothesis}</p>
        </div>
        <div className="flex gap-2">
          {statusBadge(experiment.status)}
          {experiment.verdict && chip(experiment.verdict)}
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs text-muted">Channel</p>
          <p className="mt-1 text-sm font-semibold text-ink">{experiment.channel}</p>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs text-muted">Primary metric</p>
          <p className="mt-1 text-sm font-semibold text-ink">{experiment.primaryMetric}</p>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs text-muted">Stated MDE</p>
          <p className="mt-1 text-sm font-semibold text-ink">{(experiment.statedMde * 100).toFixed(1)}% lift</p>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs text-muted">Min runtime</p>
          <p className="mt-1 text-sm font-semibold text-ink">{experiment.minRuntimeDays} days</p>
        </div>
      </div>

      <section className="rounded-xl border border-line bg-white p-4">
        <h2 className="text-sm font-semibold tracking-tight text-ink">Variants</h2>
        <div className="mt-2 space-y-1.5">
          {experiment.variants.map((v) => (
            <div key={v.id} className="flex items-center justify-between rounded-lg border border-line bg-hover-paper px-3 py-2 text-sm">
              <div>
                <span className="font-medium text-ink">{v.name}</span>
                {v.description && <span className="ml-2 text-muted">{v.description}</span>}
              </div>
              {chip(`${(v.weight * 100).toFixed(0)}%`, "border-line bg-canvas text-muted")}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          Guardrails: {experiment.guardrailMetrics.length > 0
            ? experiment.guardrailMetrics.map((g) => `${g.name} (±${(g.tolerance * 100).toFixed(0)}%)`).join(", ")
            : "none declared"}
          {" · "}Profit guardrail: {experiment.profitGuardrail ? "declared" : "not declared"}
        </p>
        {experiment.trafficFloorNote && (
          <p className="mt-2 rounded-lg border border-line bg-canvas p-3 text-xs text-muted">{experiment.trafficFloorNote}</p>
        )}
      </section>

      {badges && (
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="text-sm font-semibold tracking-tight text-ink">Honesty dashboard</h2>
          <p className="mt-2 text-lg font-medium">{String(stats.headline ?? "")}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-line p-3">
              <p className="flex items-center gap-1 text-xs font-medium"><Gauge className="h-3 w-3" /> Power</p>
              <div className="mt-1">{chip(badges.power.label)}</div>
              <p className="mt-1 text-xs text-muted">{badges.power.detail}</p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <p className="flex items-center gap-1 text-xs font-medium"><CalendarClock className="h-3 w-3" /> Maturity</p>
              <div className="mt-1">{chip(badges.maturity.label)}</div>
              <p className="mt-1 text-xs text-muted">{badges.maturity.detail}</p>
            </div>
            <div className="rounded-lg border border-line p-3">
              <p className="flex items-center gap-1 text-xs font-medium">
                {badges.integrity.label === "clean"
                  ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />} Integrity
              </p>
              <div className="mt-1">{chip(badges.integrity.label)}</div>
              <p className="mt-1 text-xs text-muted">{badges.integrity.detail}</p>
            </div>
          </div>
          {Array.isArray(stats.guidance) && stats.guidance.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
              {(stats.guidance as string[]).map((g, i) => <li key={i}>{g}</li>)}
            </ul>
          )}
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><p className="text-xs text-muted">Chance to beat</p><p className="font-semibold">{(Number(stats.prob_to_beat ?? 0) * 100).toFixed(1)}%</p></div>
            <div><p className="text-xs text-muted">Expected uplift</p><p className="font-semibold">{(Number(stats.expected_uplift ?? 0) * 100).toFixed(1)}%</p></div>
            <div><p className="text-xs text-muted">Expected loss</p><p className="font-semibold">{(Number(stats.expected_loss ?? 0) * 100).toFixed(2)}%</p></div>
            <div><p className="text-xs text-muted">Frequentist p (backstop)</p><p className="font-semibold">{Number(stats.frequentist_p ?? 1).toFixed(4)}</p></div>
          </div>
        </section>
      )}

      {canEdit && <TestLabActions experiment={experiment} />}

      {experiment.qaReport && (
        <section className="rounded-xl border border-line bg-white p-4">
          <h2 className="text-sm font-semibold tracking-tight text-ink">QA report</h2>
          <div className="mt-3 space-y-2">
            {experiment.qaReport.checks.map((c) => (
              <div key={c.name} className="flex items-start gap-2 text-sm">
                {qaChip(c.passed)}
                <div><p className="font-medium">{c.name}</p><p className="text-muted">{c.detail}</p></div>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <p className="text-sm font-medium">Force-QA links</p>
            <ul className="mt-1 space-y-1 text-xs text-muted">
              {Object.entries(experiment.qaReport.forceQaLinks).map(([vid, url]) => (
                <li key={vid}><span className="font-mono">{vid}</span>: <span className="break-all">{url}</span></li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">
              Cookie preview: <span className="font-mono">{experiment.qaReport.cookiePreview.cookieName}={experiment.qaReport.cookiePreview.cookieValue}</span>
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
