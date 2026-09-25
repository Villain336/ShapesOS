// Marketr — I1 Onboarding Intelligence Report (Phase 6).
// The wedge demo surface: twelve audits with completeness labels, revenue
// opportunities ranked by impact × effort, and the human-adjustable 90-day
// Growth Plan — dashboard view + PDF export. Missing data is labeled
// partial/unavailable, never fabricated; every audit cites its data source.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getReportBundle, listReports } from "@/lib/authority/intelligence/reports";
import { AUDIT_ORDER, AUDIT_NAMES } from "@/lib/authority/intelligence/types";
import type { AuditResult, Completeness, PlanInitiative } from "@/lib/authority/intelligence/types";
import { Badge } from "@/components/vault/shadcn/badge";
import { Separator } from "@/components/vault/shadcn/separator";
import { GenerateReportButton } from "./_components/GenerateReportButton";
import { FinalizeReportButton } from "./_components/FinalizeReportButton";
import { PlanBoard } from "./_components/PlanBoard";
import {
  Building2, Globe2, Network, MonitorSmartphone, Palette, Search,
  Megaphone, Star, Filter, Users, FileText, Cpu,
  TriangleAlert, CircleAlert, Info, Download, FileSearch, Sparkles,
  ChevronRight, CircleDollarSign,
} from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Intelligence Report — Marketr",
  description: "Twelve audits, ranked revenue opportunities, and the 90-day Growth Plan.",
};

const AUDIT_ICONS = {
  company: Building2, market: Globe2, "competitor-map": Network, website: MonitorSmartphone,
  brand: Palette, seo: Search, paid: Megaphone, reputation: Star, conversion: Filter,
  crm: Users, content: FileText, technology: Cpu,
} as const;

const COMPLETENESS_STYLES: Record<Completeness, string> = {
  full: "bg-emerald-50 text-emerald-700 border-emerald-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200",
  unavailable: "bg-stone-100 text-stone-500 border-stone-200",
};

const COMPLETENESS_LABEL: Record<Completeness, string> = {
  full: "Full data",
  partial: "Partial data",
  unavailable: "Unavailable",
};

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-indigo-50 text-indigo-700 border-indigo-200",
  ready: "bg-emerald-50 text-emerald-700 border-emerald-200",
  archived: "bg-stone-100 text-stone-500 border-stone-200",
};

function scoreStyle(score: number | null) {
  if (score == null) return "text-stone-400";
  if (score >= 70) return "text-emerald-600";
  if (score >= 45) return "text-amber-600";
  return "text-rose-600";
}

function scoreBar(score: number | null) {
  if (score == null) return "bg-stone-200";
  if (score >= 70) return "bg-emerald-500";
  if (score >= 45) return "bg-amber-500";
  return "bg-rose-500";
}

const SEVERITY_ICON = { critical: TriangleAlert, warn: CircleAlert, info: Info } as const;
const SEVERITY_COLOR = {
  critical: "text-rose-600",
  warn: "text-amber-600",
  info: "text-stone-400",
} as const;

function fmtMoney(usd: number) {
  return `~$${Math.round(usd).toLocaleString("en-US")}/yr`;
}

function fmtDate(d: Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function AuditCard({ audit }: { audit: AuditResult }) {
  const Icon = AUDIT_ICONS[audit.id] ?? FileSearch;
  const top = audit.findings.slice(0, 3);
  return (
    <article className="flex flex-col rounded-xl border border-stone-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
            <Icon className="h-4.5 w-4.5" />
          </span>
          <h3 className="text-sm font-semibold text-stone-900">{audit.name}</h3>
        </div>
        <Badge variant="outline" className={COMPLETENESS_STYLES[audit.completeness]}>
          {COMPLETENESS_LABEL[audit.completeness]}
        </Badge>
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className={`text-3xl font-bold tracking-tight ${scoreStyle(audit.score)}`}>
          {audit.score == null ? "—" : audit.score}
        </span>
        <span className="text-xs text-stone-400">/ 100</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
        <div
          className={`h-full rounded-full ${scoreBar(audit.score)}`}
          style={{ width: audit.score == null ? "0%" : `${audit.score}%` }}
        />
      </div>

      <ul className="mt-3 flex-1 space-y-2.5">
        {top.map((f, i) => {
          const SIcon = SEVERITY_ICON[f.severity];
          return (
            <li key={i} className="flex gap-2">
              <SIcon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${SEVERITY_COLOR[f.severity]}`} />
              <div className="min-w-0">
                <p className="text-xs font-medium text-stone-800">{f.title}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-stone-500">{f.detail}</p>
                <p className="mt-0.5 text-[11px] italic text-stone-400">Source: {f.dataSource}</p>
              </div>
            </li>
          );
        })}
        {audit.findings.length === 0 && (
          <li className="text-xs text-stone-400">
            {audit.completeness === "unavailable"
              ? "No data available — connect the contributing data sources to unlock this audit."
              : "No findings recorded."}
          </li>
        )}
      </ul>
      {audit.findings.length > 3 && (
        <p className="mt-2 text-[11px] text-stone-400">+ {audit.findings.length - 3} more findings in the PDF.</p>
      )}
      <Separator className="my-3" />
      <p className="text-[11px] text-stone-400">Primary source: {audit.dataSource}</p>
    </article>
  );
}

export default async function IntelligencePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canEdit = membership.role !== "viewer";

  const { id: requestedId } = await searchParams;
  const reports = await listReports(workspace.id).catch(() => []);
  const reportId = requestedId ?? reports[0]?.id ?? null;

  const [client, project] = await Promise.all([
    prisma.client.findFirst({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
      select: { name: true },
    }).catch(() => null),
    prisma.project.findFirst({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
      select: { domain: true },
    }).catch(() => null),
  ]);
  const brandName = client?.name ?? workspace.name ?? "Intelligence Report";
  const domain = project?.domain ?? null;

  const row = reportId
    ? await prisma.intelligenceReport
        .findFirst({ where: { id: reportId, workspaceId: workspace.id } })
        .catch(() => null)
    : null;
  const bundle = row ? await getReportBundle(row.id, workspace.id).catch(() => null) : null;

  const audits = bundle ? [...bundle.audits].sort(
    (a, b) => AUDIT_ORDER.indexOf(a.id) - AUDIT_ORDER.indexOf(b.id),
  ) : [];
  const scored = audits.filter((a) => a.score != null);
  const readiness = scored.length
    ? Math.round(scored.reduce((s, a) => s + (a.score as number), 0) / scored.length)
    : null;
  const counts = {
    full: audits.filter((a) => a.completeness === "full").length,
    partial: audits.filter((a) => a.completeness === "partial").length,
    unavailable: audits.filter((a) => a.completeness === "unavailable").length,
  };

  return (
    <div className="space-y-8">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-stone-500">
        <Link href="/dashboard/authority" className="hover:text-stone-800">Authority</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-stone-800">Intelligence Report</span>
      </nav>

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold tracking-[0.2em] text-indigo-600">MARKETR · INTELLIGENCE REPORT</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-900">{brandName}</h1>
          {domain && <p className="mt-0.5 text-sm text-stone-500">{domain}</p>}
          {row && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline">v{row.version}</Badge>
              <Badge variant="outline" className={STATUS_STYLES[row.status] ?? ""}>{row.status}</Badge>
              <span className="text-stone-500">Generated {fmtDate(row.generatedAt ?? row.createdAt)}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {row && (
            <a
              href={`/api/authority/intelligence/reports/${row.id}/pdf`}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-transparent bg-stone-100 px-2.5 text-sm font-medium text-stone-800 transition hover:bg-stone-200"
            >
              <Download className="h-4 w-4" /> Export PDF
            </a>
          )}
          {row && row.status === "draft" && canEdit && <FinalizeReportButton reportId={row.id} />}
          {canEdit && <GenerateReportButton />}
        </div>
      </header>

      {reports.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
          <span className="font-medium">History:</span>
          {reports.slice(0, 8).map((r) => (
            <Link
              key={r.id}
              href={`/dashboard/authority/intelligence?id=${r.id}`}
              className={`rounded-full border px-3 py-1 transition ${
                r.id === row?.id
                  ? "border-indigo-300 bg-indigo-50 font-medium text-indigo-700"
                  : "border-stone-200 bg-white text-stone-600 hover:border-stone-400"
              }`}
            >
              {fmtDate(r.generatedAt ?? r.createdAt)} · {r.status}
            </Link>
          ))}
        </div>
      )}

      {!bundle || !row ? (
        /* Empty state — no report yet */
        <div className="mx-auto flex max-w-xl flex-col items-center rounded-2xl border border-dashed border-stone-300 bg-white px-8 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
            <Sparkles className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-stone-900">No intelligence report yet</h2>
          <p className="mt-2 text-sm text-stone-500">
            Connect your stack, then compile: twelve audits run against the data Marketr already
            holds — from onboarding intake to paid media — plus ranked revenue opportunities and a
            90-day Growth Plan. Missing connections degrade to labeled partial, never fabricated.
          </p>
          <div className="mt-6 flex items-center gap-3">
            {canEdit ? (
              <GenerateReportButton />
            ) : (
              <p className="text-xs text-stone-400">Ask an editor or admin to generate the first report.</p>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Readiness hero */}
          <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center gap-8">
              <div className="flex items-center gap-5">
                <span className={`text-6xl font-bold tracking-tight ${scoreStyle(readiness)}`}>
                  {readiness == null ? "—" : readiness}
                </span>
                <div>
                  <p className="text-sm font-semibold text-stone-900">Overall readiness</p>
                  <p className="text-xs text-stone-500">
                    {scored.length} of 12 audits scored · average of scored audits
                  </p>
                </div>
              </div>
              <Separator orientation="vertical" className="hidden h-16 md:block" />
              <div className="flex flex-wrap gap-2.5">
                <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 px-3 py-1.5">
                  {counts.full} full-data
                </Badge>
                <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 px-3 py-1.5">
                  {counts.partial} partial
                </Badge>
                <Badge variant="outline" className="bg-stone-100 text-stone-500 border-stone-200 px-3 py-1.5">
                  {counts.unavailable} unavailable
                </Badge>
              </div>
              <p className="w-full text-xs text-stone-400">
                Sections labeled partial or unavailable reflect missing connections or data — never fabricated numbers.
              </p>
            </div>
          </section>

          {/* Twelve audits */}
          <section>
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-lg font-semibold tracking-tight text-stone-900">The twelve audits</h2>
              <p className="text-xs text-stone-500">Each audit cites the Marketr module that produced it.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {audits.map((a) => (
                <AuditCard key={a.id} audit={a} />
              ))}
            </div>
          </section>

          {/* Revenue opportunities */}
          <section>
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-lg font-semibold tracking-tight text-stone-900">
                Revenue opportunities, ranked
              </h2>
              <p className="text-xs text-stone-500">Impact × effort · impact figures are estimates, not forecasts.</p>
            </div>
            {bundle.opportunities.length === 0 ? (
              <p className="rounded-xl border border-dashed border-stone-300 bg-white p-6 text-center text-sm text-stone-400">
                No opportunities derived — most likely too few audits have data to work from.
              </p>
            ) : (
              <ol className="space-y-3">
                {bundle.opportunities.map((o, i) => (
                  <li
                    key={o.id}
                    className="flex gap-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm transition hover:shadow-md"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-sm font-semibold text-stone-900">{o.title}</h3>
                        <span className="inline-flex items-center gap-1 text-sm font-bold text-indigo-700">
                          <CircleDollarSign className="h-4 w-4" />
                          {fmtMoney(o.impactUsd)}
                          <span className="text-[11px] font-normal text-stone-400">estimate</span>
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-stone-600">{o.description}</p>
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-stone-500">
                        <span className="inline-flex items-center gap-1">
                          <span className="text-stone-400">Effort</span>
                          {Array.from({ length: 5 }).map((_, d) => (
                            <span
                              key={d}
                              className={`h-1.5 w-4 rounded-full ${d < o.effort ? "bg-indigo-500" : "bg-stone-200"}`}
                            />
                          ))}
                        </span>
                        <Badge
                          variant="outline"
                          className={
                            o.confidence === "high"
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : o.confidence === "medium"
                                ? "bg-amber-50 text-amber-700 border-amber-200"
                                : "bg-stone-100 text-stone-500 border-stone-200"
                          }
                        >
                          {o.confidence} confidence
                        </Badge>
                        <span>Executes in: <strong className="font-medium text-stone-700">{o.executesIn}</strong></span>
                        <span>From: <strong className="font-medium text-stone-700">{AUDIT_NAMES[o.auditId]}</strong></span>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* 90-day Growth Plan */}
          <section>
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-stone-900">90-day Growth Plan</h2>
                <p className="mt-0.5 text-xs text-stone-500">
                  Each initiative is mapped to the Marketr module that executes it.
                  {canEdit && row.status === "draft"
                    ? " Adjust priority with the arrows — a human reviews before the plan becomes the baseline."
                    : " Priorities adjust during the draft review window."}
                </p>
              </div>
              {row.status === "draft" && canEdit && <FinalizeReportButton reportId={row.id} />}
            </div>
            {bundle.plan.initiatives.length === 0 ? (
              <p className="rounded-xl border border-dashed border-stone-300 bg-white p-6 text-center text-sm text-stone-400">
                No initiatives compiled for this report.
              </p>
            ) : canEdit && row.status === "draft" ? (
              <PlanBoard reportId={row.id} initial={bundle.plan.initiatives} />
            ) : (
              <PlanBoardReadOnly initiatives={bundle.plan.initiatives} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function PlanBoardReadOnly({ initiatives }: { initiatives: PlanInitiative[] }) {
  const sprints = [
    { sprint: 30 as const, label: "Days 1–30" },
    { sprint: 60 as const, label: "Days 31–60" },
    { sprint: 90 as const, label: "Days 61–90" },
  ];
  const ordered = [...initiatives].sort((a, b) => a.priority - b.priority);
  return (
    <div className="space-y-8">
      {sprints.map((s) => {
        const items = ordered.filter((i) => i.sprint === s.sprint);
        if (items.length === 0) return null;
        return (
          <section key={s.sprint} aria-label={s.label}>
            <h3 className="mb-3 text-sm font-semibold tracking-tight text-stone-900">{s.label}</h3>
            <ol className="space-y-3">
              {items.map((i) => (
                <li key={i.id} className="flex items-start gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-sm font-bold text-indigo-700">
                    {i.priority}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-stone-900">{i.title}</p>
                      {i.adjustedByHuman && (
                        <Badge variant="outline" className="border-indigo-200 bg-indigo-50 text-indigo-700">
                          human-adjusted
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-stone-600">{i.description}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="secondary" className="bg-stone-100 text-stone-700">
                        Executes in: {i.module}
                      </Badge>
                      <Badge variant="outline">{i.effort} effort</Badge>
                      <span className="text-stone-500">Expected: {i.expectedOutcome}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
