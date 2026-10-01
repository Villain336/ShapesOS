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

// Data completeness is analytic, never status-colored — neutral chips.
const COMPLETENESS_CHIP: Record<Completeness, string> = {
  full: "border-line bg-paper text-muted shadow-control",
  partial: "border-line bg-paper text-muted shadow-control",
  unavailable: "border-line bg-paper text-muted shadow-control",
};

const COMPLETENESS_LABEL: Record<Completeness, string> = {
  full: "Full data",
  partial: "Partial data",
  unavailable: "Unavailable",
};

const STATUS_CHIP: Record<string, string> = {
  draft: "bg-needs text-ink",
  ready: "bg-done text-white",
  archived: "border-line bg-paper text-muted shadow-control",
};

function chip(text: React.ReactNode, cls: string) {
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${cls}`}>
      {text}
    </span>
  );
}

// Audit scores are analytic, never status-colored.
function scoreStyle(score: number | null) {
  if (score == null) return "text-subtle";
  return "text-ink";
}

function scoreBar(score: number | null) {
  if (score == null) return "bg-line";
  return "bg-ink";
}

const SEVERITY_ICON = { critical: TriangleAlert, warn: CircleAlert, info: Info } as const;
const SEVERITY_COLOR = {
  critical: "text-failed-text",
  warn: "text-ink",
  info: "text-subtle",
} as const;

function fmtMoney(usd: number) {
  return `~$${Math.round(usd).toLocaleString("en-US")}/yr`;
}

function fmtDate(d: Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function AuditRows({ audits }: { audits: AuditResult[] }) {
  return (
    <>
      {audits.map((audit) => {
        const Icon = AUDIT_ICONS[audit.id] ?? FileSearch;
        const top = audit.findings.slice(0, 3);
        return (
          <>
            <tr key={audit.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
              <td className="px-3 py-2">
                <span className="flex items-center gap-2 font-medium text-ink">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-paper text-ink">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  {audit.name}
                </span>
              </td>
              <td className="px-3 py-2">{chip(COMPLETENESS_LABEL[audit.completeness], COMPLETENESS_CHIP[audit.completeness])}</td>
              <td className="px-3 py-2">
                <span className={`font-bold ${scoreStyle(audit.score)}`}>
                  {audit.score == null ? "—" : audit.score}
                  <span className="font-normal text-subtle"> / 100</span>
                </span>
                <span className="mt-1 block h-1.5 w-24 overflow-hidden rounded-full bg-paper">
                  <span className={`block h-full rounded-full ${scoreBar(audit.score)}`} style={{ width: audit.score == null ? "0%" : `${audit.score}%` }} />
                </span>
              </td>
              <td className="px-3 py-2 text-[12px] text-muted">{audit.dataSource}</td>
            </tr>
            <tr key={`${audit.id}-findings`} className="border-b border-line bg-paper/40">
              <td colSpan={4} className="px-3 py-2">
                {top.length === 0 ? (
                  <p className="text-[12px] text-subtle">
                    {audit.completeness === "unavailable"
                      ? "No data available — connect the contributing data sources to unlock this audit."
                      : "No findings recorded."}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {top.map((f, i) => {
                      const SIcon = SEVERITY_ICON[f.severity];
                      return (
                        <li key={i} className="flex gap-2">
                          <SIcon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${SEVERITY_COLOR[f.severity]}`} />
                          <div className="min-w-0">
                            <p className="text-[12px] font-medium text-ink">{f.title}</p>
                            <p className="line-clamp-1 text-[12px] text-muted">{f.detail}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {audit.findings.length > 3 && (
                  <p className="mt-1 text-[11px] text-subtle">+ {audit.findings.length - 3} more findings in the PDF.</p>
                )}
              </td>
            </tr>
          </>
        );
      })}
    </>
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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-muted">
        <Link href="/dashboard/authority" className="hover:text-ink">Authority</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-ink">Intelligence Report</span>
      </nav>

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[13px] text-muted">Intelligence report</p>
          <h1 className="mt-1 aos-heading">{brandName}</h1>
          {domain && <p className="mt-0.5 text-[13px] text-muted">{domain}</p>}
          {row && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
              {chip(`v${row.version}`, "border-line bg-paper text-muted")}
              {chip(row.status, STATUS_CHIP[row.status] ?? STATUS_CHIP.archived)}
              <span className="text-muted">Generated {fmtDate(row.generatedAt ?? row.createdAt)}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {row && (
            <a
              href={`/api/authority/intelligence/reports/${row.id}/pdf`}
              className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
            >
              <Download className="h-4 w-4" /> Export PDF
            </a>
          )}
          {row && row.status === "draft" && canEdit && <FinalizeReportButton reportId={row.id} />}
          {canEdit && <GenerateReportButton />}
        </div>
      </header>

      {reports.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="font-medium">History:</span>
          {reports.slice(0, 8).map((r) => (
            <Link
              key={r.id}
              href={`/dashboard/authority/intelligence?id=${r.id}`}
              className={`rounded-full border px-3 py-1 transition ${
                r.id === row?.id
                  ? "border-ink bg-paper font-medium text-ink"
                  : "border-line bg-paper text-muted hover:border-ink"
              }`}
            >
              {fmtDate(r.generatedAt ?? r.createdAt)} · {r.status}
            </Link>
          ))}
        </div>
      )}

      {!bundle || !row ? (
        /* Empty state — no report yet */
        <div className="mx-auto flex max-w-xl flex-col items-center rounded-2xl border border-dashed border-line bg-paper px-8 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-paper text-ink">
            <Sparkles className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-ink">No intelligence report yet</h2>
          <p className="mt-2 text-sm text-muted">
            Connect your stack, then compile: twelve audits run against the data Marketr already
            holds — from onboarding intake to paid media — plus ranked revenue opportunities and a
            90-day Growth Plan. Missing connections degrade to labeled partial, never fabricated.
          </p>
          <div className="mt-6 flex items-center gap-3">
            {canEdit ? (
              <GenerateReportButton />
            ) : (
              <p className="text-xs text-subtle">Ask an editor or admin to generate the first report.</p>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Readiness hero */}
          <section className="rounded-2xl border border-line bg-paper p-6">
            <div className="flex flex-wrap items-center gap-8">
              <div className="flex items-center gap-5">
                <span className={`text-6xl font-bold tracking-tight ${scoreStyle(readiness)}`}>
                  {readiness == null ? "—" : readiness}
                </span>
                <div>
                  <p className="text-sm font-semibold text-ink">Overall readiness</p>
                  <p className="text-xs text-muted">
                    {scored.length} of 12 audits scored · average of scored audits
                  </p>
                </div>
              </div>
              <Separator orientation="vertical" className="hidden h-16 md:block" />
              <div className="flex flex-wrap gap-2.5">
                {chip(`${counts.full} full-data`, "border-line bg-paper text-muted shadow-control")}
                {chip(`${counts.partial} partial`, "border-line bg-paper text-muted shadow-control")}
                {chip(`${counts.unavailable} unavailable`, "border-line bg-paper text-muted")}
              </div>
              <p className="w-full text-xs text-subtle">
                Sections labeled partial or unavailable reflect missing connections or data — never fabricated numbers.
              </p>
            </div>
          </section>

          {/* Twelve audits */}
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-ink">The twelve audits</h2>
              <p className="text-xs text-muted">Each audit cites the Marketr module that produced it.</p>
            </div>
            <div className="overflow-x-auto rounded-lg border border-line bg-paper">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-paper/60 text-[11px] text-muted">
                    <th className="px-3 py-2 font-medium">Audit</th>
                    <th className="px-3 py-2 font-medium">Completeness</th>
                    <th className="px-3 py-2 font-medium">Score</th>
                    <th className="px-3 py-2 font-medium">Primary source</th>
                  </tr>
                </thead>
                <tbody>
                  <AuditRows audits={audits} />
                </tbody>
              </table>
            </div>
          </section>

          {/* Revenue opportunities */}
          <section>
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-ink">
                Revenue opportunities, ranked
              </h2>
              <p className="text-xs text-muted">Impact × effort · impact figures are estimates, not forecasts.</p>
            </div>
            {bundle.opportunities.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line bg-paper p-6 text-center text-sm text-subtle">
                No opportunities derived — most likely too few audits have data to work from.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-line bg-paper">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line bg-paper/60 text-[11px] text-muted">
                      <th className="px-3 py-2 font-medium">#</th>
                      <th className="px-3 py-2 font-medium">Opportunity</th>
                      <th className="px-3 py-2 font-medium">Impact</th>
                      <th className="px-3 py-2 font-medium">Effort</th>
                      <th className="px-3 py-2 font-medium">Confidence</th>
                      <th className="px-3 py-2 font-medium">Executes in</th>
                      <th className="px-3 py-2 font-medium">From audit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bundle.opportunities.map((o, i) => (
                      <tr key={o.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                        <td className="px-3 py-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[11px] font-bold text-white">
                            {i + 1}
                          </span>
                        </td>
                        <td className="max-w-xs px-3 py-2">
                          <span className="font-medium text-ink">{o.title}</span>
                          <span className="block text-[12px] text-muted line-clamp-2">{o.description}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-1 font-bold text-ink">
                            <CircleDollarSign className="h-4 w-4" />
                            {fmtMoney(o.impactUsd)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-0.5">
                            {Array.from({ length: 5 }).map((_, d) => (
                              <span
                                key={d}
                                className={`h-1.5 w-4 rounded-full ${d < o.effort ? "bg-ink" : "bg-line"}`}
                              />
                            ))}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {chip(`${o.confidence} confidence`,
                            "border-line bg-paper text-muted shadow-control")}
                        </td>
                        <td className="px-3 py-2 text-[12px] text-muted">{o.executesIn}</td>
                        <td className="px-3 py-2 text-[12px] text-muted">{AUDIT_NAMES[o.auditId]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 90-day Growth Plan */}
          <section>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-ink">90-day Growth Plan</h2>
                <p className="mt-0.5 text-xs text-muted">
                  Each initiative is mapped to the Marketr module that executes it.
                  {canEdit && row.status === "draft"
                    ? " Adjust priority with the arrows — a human reviews before the plan becomes the baseline."
                    : " Priorities adjust during the draft review window."}
                </p>
              </div>
              {row.status === "draft" && canEdit && <FinalizeReportButton reportId={row.id} />}
            </div>
            {bundle.plan.initiatives.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line bg-paper p-6 text-center text-sm text-subtle">
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
    <div className="space-y-4">
      {sprints.map((s) => {
        const items = ordered.filter((i) => i.sprint === s.sprint);
        if (items.length === 0) return null;
        return (
          <section key={s.sprint} aria-label={s.label}>
            <h3 className="mb-2 text-sm font-semibold tracking-tight text-ink">{s.label}</h3>
            <div className="overflow-x-auto rounded-lg border border-line bg-paper">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-paper/60 text-[11px] text-muted">
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">Initiative</th>
                    <th className="px-3 py-2 font-medium">Module</th>
                    <th className="px-3 py-2 font-medium">Effort</th>
                    <th className="px-3 py-2 font-medium">Expected outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[11px] font-bold text-white">
                          {i.priority}
                        </span>
                      </td>
                      <td className="max-w-xs px-3 py-2">
                        <span className="flex flex-wrap items-center gap-1.5 font-medium text-ink">
                          {i.title}
                          {i.adjustedByHuman && chip("human-adjusted", "border-line bg-paper text-muted shadow-control")}
                        </span>
                        <span className="block text-[12px] text-muted line-clamp-2">{i.description}</span>
                      </td>
                      <td className="px-3 py-2 text-[12px] text-muted">{i.module}</td>
                      <td className="px-3 py-2 text-[12px] text-muted">{i.effort}</td>
                      <td className="px-3 py-2 text-[12px] text-muted">{i.expectedOutcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
