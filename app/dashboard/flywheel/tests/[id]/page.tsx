// Marketr — Test Lab experiment detail: lifecycle, QA, honesty dashboard.
// Mirrors app/dashboard/authority conventions (server page + client actions).

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
function chip(text: React.ReactNode, cls: string) {
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${cls}`}>
      {text}
    </span>
  );
}
import { ArrowLeft, ShieldAlert, ShieldCheck, Gauge, CalendarClock } from "lucide-react";
import { TestLabActions } from "./_components/TestLabActions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Experiment — Test Lab — Marketr",
};

const STATUS_CHIP: Record<string, string> = {
  running: "border-violet-200 bg-violet-50 text-violet-700",
  complete: "border-stone-200 bg-stone-100 text-stone-600",
  qa: "border-amber-200 bg-amber-50 text-amber-700",
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
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <nav className="flex items-center gap-1.5 text-xs text-stone-500">
        <Link href="/dashboard/flywheel/tests" className="inline-flex items-center gap-1 hover:text-stone-800">
          <ArrowLeft className="h-3 w-3" /> Test Lab
        </Link>
        <span>/</span>
        <span className="font-medium text-stone-800">{experiment.name}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">{experiment.name}</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-stone-500">{experiment.hypothesis}</p>
        </div>
        <div className="flex gap-2">
          {chip(experiment.status, STATUS_CHIP[experiment.status] ?? STATUS_CHIP.complete)}
          {experiment.verdict && chip(experiment.verdict,
            experiment.verdict === "winner" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-stone-200 bg-stone-100 text-stone-600")}
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <p className="text-xs text-stone-500">Channel</p>
          <p className="mt-1 text-sm font-semibold text-stone-900">{experiment.channel}</p>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <p className="text-xs text-stone-500">Primary metric</p>
          <p className="mt-1 text-sm font-semibold text-stone-900">{experiment.primaryMetric}</p>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <p className="text-xs text-stone-500">Stated MDE</p>
          <p className="mt-1 text-sm font-semibold text-stone-900">{(experiment.statedMde * 100).toFixed(1)}% lift</p>
        </div>
        <div className="rounded-xl border border-stone-200 bg-white p-4">
          <p className="text-xs text-stone-500">Min runtime</p>
          <p className="mt-1 text-sm font-semibold text-stone-900">{experiment.minRuntimeDays} days</p>
        </div>
      </div>

      <section className="rounded-xl border border-stone-200 bg-white p-4">
        <h2 className="text-sm font-semibold tracking-tight text-stone-900">Variants</h2>
        <div className="mt-2 space-y-1.5">
          {experiment.variants.map((v) => (
            <div key={v.id} className="flex items-center justify-between rounded-lg border border-stone-100 bg-stone-50/40 px-3 py-2 text-sm">
              <div>
                <span className="font-medium text-stone-900">{v.name}</span>
                {v.description && <span className="ml-2 text-stone-500">{v.description}</span>}
              </div>
              {chip(`${(v.weight * 100).toFixed(0)}%`, "border-stone-200 bg-stone-50 text-stone-600")}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-stone-500">
          Guardrails: {experiment.guardrailMetrics.length > 0
            ? experiment.guardrailMetrics.map((g) => `${g.name} (±${(g.tolerance * 100).toFixed(0)}%)`).join(", ")
            : "none declared"}
          {" · "}Profit guardrail: {experiment.profitGuardrail ? "declared" : "not declared"}
        </p>
        {experiment.trafficFloorNote && (
          <p className="mt-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600">{experiment.trafficFloorNote}</p>
        )}
      </section>

      {badges && (
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="text-sm font-semibold tracking-tight text-stone-900">Honesty dashboard</h2>
          <p className="mt-2 text-lg font-medium">{String(stats.headline ?? "")}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-stone-100 p-3">
              <p className="flex items-center gap-1 text-xs font-medium"><Gauge className="h-3 w-3" /> Power</p>
              <div className="mt-1">{chip(badges.power.label, badges.power.label === "powered" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700")}</div>
              <p className="mt-1 text-xs text-stone-500">{badges.power.detail}</p>
            </div>
            <div className="rounded-lg border border-stone-100 p-3">
              <p className="flex items-center gap-1 text-xs font-medium"><CalendarClock className="h-3 w-3" /> Maturity</p>
              <div className="mt-1">{chip(badges.maturity.label, badges.maturity.label === "mature" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-stone-200 bg-stone-50 text-stone-600")}</div>
              <p className="mt-1 text-xs text-stone-500">{badges.maturity.detail}</p>
            </div>
            <div className="rounded-lg border border-stone-100 p-3">
              <p className="flex items-center gap-1 text-xs font-medium">
                {badges.integrity.label === "clean"
                  ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />} Integrity
              </p>
              <div className="mt-1">{chip(badges.integrity.label, badges.integrity.label === "clean" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700")}</div>
              <p className="mt-1 text-xs text-stone-500">{badges.integrity.detail}</p>
            </div>
          </div>
          {Array.isArray(stats.guidance) && stats.guidance.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-stone-500">
              {(stats.guidance as string[]).map((g, i) => <li key={i}>{g}</li>)}
            </ul>
          )}
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><p className="text-xs text-stone-500">Chance to beat</p><p className="font-semibold">{(Number(stats.prob_to_beat ?? 0) * 100).toFixed(1)}%</p></div>
            <div><p className="text-xs text-stone-500">Expected uplift</p><p className="font-semibold">{(Number(stats.expected_uplift ?? 0) * 100).toFixed(1)}%</p></div>
            <div><p className="text-xs text-stone-500">Expected loss</p><p className="font-semibold">{(Number(stats.expected_loss ?? 0) * 100).toFixed(2)}%</p></div>
            <div><p className="text-xs text-stone-500">Frequentist p (backstop)</p><p className="font-semibold">{Number(stats.frequentist_p ?? 1).toFixed(4)}</p></div>
          </div>
        </section>
      )}

      {canEdit && <TestLabActions experiment={experiment} />}

      {experiment.qaReport && (
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="text-sm font-semibold tracking-tight text-stone-900">QA report</h2>
          <div className="mt-3 space-y-2">
            {experiment.qaReport.checks.map((c) => (
              <div key={c.name} className="flex items-start gap-2 text-sm">
                {chip(c.passed ? "pass" : "fail", c.passed ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700")}
                <div><p className="font-medium">{c.name}</p><p className="text-stone-500">{c.detail}</p></div>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <p className="text-sm font-medium">Force-QA links</p>
            <ul className="mt-1 space-y-1 text-xs text-stone-500">
              {Object.entries(experiment.qaReport.forceQaLinks).map(([vid, url]) => (
                <li key={vid}><span className="font-mono">{vid}</span>: <span className="break-all">{url}</span></li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-stone-500">
              Cookie preview: <span className="font-mono">{experiment.qaReport.cookiePreview.cookieName}={experiment.qaReport.cookiePreview.cookieValue}</span>
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
