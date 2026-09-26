// Marketr — A1 AEO command center.
// Track: per-engine scoring (mention rate, Answer Share of Voice, recommendation
// rate, sentiment distribution, trend deltas) — NEVER a composite or
// cross-engine score. Source-impact ranking. Act: owned-domain GEO16 fix
// proposals with approval state + third-party action plans with expected lift,
// deadlines, and approve buttons. Prompt-set manager + weekly run trigger.
// Honest labeling throughout: API-based tracking is a proxy of consumer
// surfaces; per-engine spread is disclosed, not averaged.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { authorityTablesReady } from "@/lib/authority/db";
import { prisma } from "@/lib/prisma";
import {
  scoreEngine,
  roundScore,
  type PerEngineScore,
  type ScorableMention,
} from "@/lib/authority/aeo/scoring";
import {
  AEO_ENGINES,
  ENGINE_LABELS,
  ENGINE_MODELS,
  AEO_PROXY_DISCLAIMER,
  type AeoEngineName,
} from "@/lib/authority/aeo/engines";
import { Separator } from "@/components/vault/shadcn/separator";
import { Input } from "@/components/vault/shadcn/input";
import {
  Info,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Minus,
  ExternalLink,
  FileSearch,
  Wrench,
  CalendarClock,
  ListOrdered,
} from "lucide-react";
import {
  ApproveActionButton,
  ActivatePromptSetButton,
  CreatePromptSetForm,
  TriggerRunCard,
} from "./_components/AeoActions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "AEO — Marketr",
  description: "Per-engine AI answer visibility tracking, source-impact analysis, and supervised fix actions.",
};

type Sentiment = "positive" | "neutral" | "negative" | null;

function pct1(n: number) {
  return `${n.toFixed(1)}%`;
}

function liftFmt(n: number) {
  const v = n * 100;
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(1)} pts`;
}

function Delta({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) return <Minus className="h-3.5 w-3.5 text-stone-300" />;
  const Icon = value > 0.05 ? TrendingUp : value < -0.05 ? TrendingDown : Minus;
  const cls = value > 0.05 ? "text-emerald-600" : value < -0.05 ? "text-red-600" : "text-stone-400";
  const sign = value > 0.05 ? "+" : value < -0.05 ? "−" : "";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${cls}`}>
      <Icon className="h-3.5 w-3.5" />
      {sign}
      {Math.abs(value).toFixed(1)} pts
    </span>
  );
}

function SentimentBar({ sentiment }: { sentiment: PerEngineScore["sentiment"] }) {
  const total = sentiment.positive + sentiment.neutral + sentiment.negative + sentiment.unmentioned;
  if (total === 0) return <p className="text-xs text-stone-400">No responses yet</p>;
  const seg = (n: number, cls: string, label: string) =>
    n > 0 ? (
      <div
        className={`h-full ${cls}`}
        style={{ width: `${(n / total) * 100}%` }}
        title={`${label}: ${n}`}
      />
    ) : null;
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-stone-100">
        {seg(sentiment.positive, "bg-emerald-500", "Positive")}
        {seg(sentiment.neutral, "bg-stone-300", "Neutral")}
        {seg(sentiment.negative, "bg-red-500", "Negative")}
        {seg(sentiment.unmentioned, "bg-stone-200", "Unmentioned")}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-stone-500">
        <span><span className="font-semibold text-emerald-700">{sentiment.positive}</span> positive</span>
        <span><span className="font-semibold text-stone-600">{sentiment.neutral}</span> neutral</span>
        <span><span className="font-semibold text-red-700">{sentiment.negative}</span> negative</span>
        <span><span className="font-semibold text-stone-500">{sentiment.unmentioned}</span> unmentioned</span>
      </div>
    </div>
  );
}

const ACTION_STATUS_CHIP: Record<string, string> = {
  proposed: "border-stone-200 bg-stone-50 text-stone-600",
  approved: "border-violet-200 bg-violet-50 text-violet-700",
  applied: "border-emerald-200 bg-emerald-50 text-emerald-700",
  done: "border-emerald-200 bg-emerald-50 text-emerald-700",
  dismissed: "border-red-200 bg-red-50 text-red-700",
};

function chip(text: React.ReactNode, cls: string) {
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${cls}`}>
      {text}
    </span>
  );
}

const PILLAR_LABELS: Record<string, string> = {
  metadata_freshness: "Metadata & freshness",
  semantic_html: "Semantic HTML",
  structured_data: "Structured data",
  query_matching_headings: "Query-matching headings",
};

interface FixProposal {
  pageUrl?: string;
  pillar?: string;
  gap?: string;
  proposedChange?: string;
  benchmarkImpactPct?: number;
  rationale?: string;
}

interface ThirdPartyPlan {
  exactTarget?: string;
  domain?: string;
  contributionAngle?: string;
  expectedLift?: number;
  deadline?: string;
}

export default async function AeoPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canEdit = membership.role === "owner" || membership.role === "admin" || membership.role === "editor";

  const { brand: brandParam } = await searchParams;
  const brand = (brandParam ?? "").trim();

  const ready = await authorityTablesReady().catch(() => false);

  let promptSets: Array<{
    id: string;
    version: number;
    promptCount: number;
    active: boolean;
    createdBy: string;
    createdAt: Date;
  }> = [];
  let impacts: Array<{
    id: string;
    engine: string;
    domain: string;
    citationFrequency: number;
    citationEfficiency: number;
    cooccurrenceLift: number;
    computedAt: Date;
  }> = [];
  let actions: Array<{
    id: string;
    kind: string;
    sourceRef: string;
    geo16Pillars: string[];
    fixProposalJson: unknown;
    actionPlanJson: unknown;
    expectedLift: number | null;
    status: string;
    createdAt: Date;
  }> = [];
  let perEngine: Record<AeoEngineName, ReturnType<typeof roundScore> | null> = {
    openai: null,
    anthropic: null,
    gemini: null,
    perplexity: null,
  };
  let deltas: Record<AeoEngineName, { mentionRate: number | null; recommendationRate: number | null }> = {
    openai: { mentionRate: null, recommendationRate: null },
    anthropic: { mentionRate: null, recommendationRate: null },
    gemini: { mentionRate: null, recommendationRate: null },
    perplexity: { mentionRate: null, recommendationRate: null },
  };
  let latestRunByEngine: Partial<Record<AeoEngineName, { startedAt: Date; version: number }>> = {};

  if (ready) {
    const [sets, completedRuns, impactRows, actionRows] = await Promise.all([
      prisma.aeoPromptSet.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { version: "desc" },
        take: 50,
      }),
      prisma.aeoRun.findMany({
        where: { workspaceId: workspace.id, status: "completed" },
        orderBy: { startedAt: "desc" },
        take: 60,
        include: { mentions: true },
      }),
      prisma.aeoSourceImpact.findMany({
        where: { workspaceId: workspace.id },
        orderBy: [{ citationFrequency: "desc" }],
        take: 100,
      }),
      prisma.aeoAction.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);
    promptSets = sets.map((s) => ({
      id: s.id,
      version: s.version,
      promptCount: (s.promptsJson as string[]).length,
      active: s.active,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
    }));
    impacts = impactRows;
    actions = actionRows.map((a) => ({
      id: a.id,
      kind: a.kind,
      sourceRef: a.sourceRef,
      geo16Pillars: a.geo16Pillars,
      fixProposalJson: a.fixProposalJson,
      actionPlanJson: a.actionPlanJson,
      expectedLift: a.expectedLift,
      status: a.status,
      createdAt: a.createdAt,
    }));

    // Per-engine scoring — latest completed run per engine is the headline;
    // the run before it supplies the trend delta. Engines are NEVER blended.
    for (const engine of AEO_ENGINES) {
      const runs = completedRuns.filter((r) => r.engine === engine);
      const map = (r: (typeof completedRuns)[number]): ScorableMention[] =>
        r.mentions.map((m) => ({
          promptIdx: m.promptIdx,
          rep: m.rep,
          mentioned: m.mentioned,
          position: m.position,
          sentiment: m.sentiment as Sentiment,
          competitors: m.competitors,
          citedSources: m.citedSources,
        }));
      if (runs.length > 0) {
        perEngine[engine] = roundScore(scoreEngine(engine, map(runs[0]), brand));
        latestRunByEngine[engine] = { startedAt: runs[0].startedAt, version: runs[0].promptSetVersion };
      }
      if (runs.length > 1) {
        const cur = scoreEngine(engine, map(runs[0]), brand);
        const prev = scoreEngine(engine, map(runs[1]), brand);
        deltas[engine] = {
          mentionRate: cur.mentionRate - prev.mentionRate,
          recommendationRate: cur.recommendationRate - prev.recommendationRate,
        };
      }
    }
  }

  const ownedFixes = actions.filter((a) => a.kind === "owned_fix");
  const thirdParty = actions.filter((a) => a.kind === "third_party_plan");
  const hasActiveSet = promptSets.some((s) => s.active);

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      {/* Header + honest labeling */}
      <div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-stone-900">AEO — answer-engine visibility</h1>
            <p className="mt-0.5 max-w-3xl text-[13px] text-stone-500">
              Versioned money-prompt sets run weekly against official LLM APIs (N=3 reps), parsed by a
              nano-class judge. The act leg turns source-impact findings into owned-domain GEO16 fixes
              (supervised ladder) and third-party user action plans.
            </p>
          </div>
          <form action="/dashboard/authority/aeo" method="GET" className="flex items-center gap-2">
            <Input
              name="brand"
              defaultValue={brand}
              placeholder="Brand for matching…"
              className="w-44 border-stone-200 bg-white text-[13px] placeholder:text-stone-400 focus-visible:border-violet-400 focus-visible:ring-violet-200/60"
            />
            <button
              type="submit"
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"
            >
              Set
            </button>
          </form>
        </div>
        <div className="mt-3 flex gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs text-stone-700">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong>{AEO_PROXY_DISCLAIMER}</strong> Metrics below are reported <strong>per engine only</strong> —
            no composite AI-visibility score exists here by design (89% cross-engine citation divergence
            makes blended scores un-actionable). The per-engine spread is the metric.
          </p>
        </div>
      </div>

      {!ready && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Authority tables are not provisioned yet — merge{" "}
          <code className="font-mono">prisma/fragments/phase6-authority.prisma</code> and migrate.
          This page renders in read-only preview until then.
        </div>
      )}

      {/* Per-engine metrics — never a composite */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-900">Per-engine visibility</h2>
          {chip("No composite score", "border-stone-200 bg-stone-50 text-stone-600")}
        </div>
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Engine</th>
                <th className="px-3 py-2 font-medium">Mention rate</th>
                <th className="px-3 py-2 font-medium">Answer SoV</th>
                <th className="px-3 py-2 font-medium">Rec rate</th>
                <th className="px-3 py-2 font-medium">Sentiment</th>
                <th className="px-3 py-2 font-medium">Responses</th>
                <th className="px-3 py-2 font-medium">Latest run</th>
              </tr>
            </thead>
            <tbody>
              {AEO_ENGINES.map((engine) => {
                const score = perEngine[engine];
                const d = deltas[engine];
                const latest = latestRunByEngine[engine];
                return (
                  <tr key={engine} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2">
                      <span className="font-medium text-stone-900">{ENGINE_LABELS[engine]}</span>
                      <span className="block font-mono text-[10px] text-stone-400">{ENGINE_MODELS[engine]}</span>
                    </td>
                    {!score ? (
                      <td colSpan={6} className="px-3 py-2 text-xs text-stone-400">No completed run yet for this engine.</td>
                    ) : (
                      <>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-1.5 font-semibold text-stone-900">
                            {pct1(score.mentionRate)}
                            <Delta value={d.mentionRate} />
                          </span>
                          <span className="mt-1 block h-1.5 w-24 overflow-hidden rounded-full bg-stone-100">
                            <span className="block h-full rounded-full bg-violet-500" style={{ width: `${score.mentionRate}%` }} />
                          </span>
                        </td>
                        <td className="px-3 py-2 font-semibold text-stone-900">{pct1(score.answerShareOfVoice)}</td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-1.5 font-semibold text-stone-900">
                            {pct1(score.recommendationRate)}
                            <Delta value={d.recommendationRate} />
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <SentimentBar sentiment={score.sentiment} />
                        </td>
                        <td className="px-3 py-2 text-[12px] text-stone-600">{score.responses} resp · {score.prompts} prompts</td>
                        <td className="px-3 py-2 text-[12px] text-stone-600">
                          {latest ? `v${latest.version} · ${latest.startedAt.toLocaleDateString()}` : "—"}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-stone-400">
          Mention rate = mean % of reps per prompt where the brand was mentioned (2/3 = 67%), not a binary flag.
          Answer share of voice = brand appearances ÷ total responses × 100.
        </p>
      </section>

      <Separator />

      {/* Source-impact ranking */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <FileSearch className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-900">Source-impact ranking</h2>
          {chip("per engine", "border-stone-200 bg-stone-50 text-stone-600")}
        </div>
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Domain</th>
                <th className="px-3 py-2 font-medium">Engine</th>
                <th className="px-4 py-2.5 font-medium" title="Times the domain was cited across the prompt set">
                  Citation frequency
                </th>
                <th className="px-4 py-2.5 font-medium" title="Citations per URL — how efficiently its pages get cited">
                  Citation efficiency
                </th>
                <th className="px-4 py-2.5 font-medium" title="P(brand recommended | source cited) − P(brand recommended | source not cited), per engine">
                  Co-occurrence lift
                </th>
                <th className="px-3 py-2 font-medium">Computed</th>
              </tr>
            </thead>
            <tbody>
              {impacts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-stone-400">
                    No source-impact data yet — run the weekly cadence, then impacts are computed from run history.
                  </td>
                </tr>
              ) : (
                impacts.map((i) => (
                  <tr key={i.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2 font-medium text-stone-900">{i.domain}</td>
                    <td className="px-3 py-2">{chip(i.engine, "border-stone-200 bg-stone-50 text-stone-600")}</td>
                    <td className="px-3 py-2 font-semibold text-stone-900">{i.citationFrequency}</td>
                    <td className="px-3 py-2 text-stone-600">{i.citationEfficiency.toFixed(2)}</td>
                    <td className="px-3 py-2">
                      <span className={`font-semibold ${i.cooccurrenceLift > 0 ? "text-emerald-700" : i.cooccurrenceLift < 0 ? "text-red-700" : "text-stone-500"}`}>
                        {liftFmt(i.cooccurrenceLift)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-stone-400">{i.computedAt.toLocaleDateString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-stone-400">
          Co-occurrence lift is the defensible impact metric: high-lift domains are where effort pays.
          Benchmarks — listicles 1.89, YouTube 1.83, review platforms 1.23, Reddit 0.73 (citations per URL).
        </p>
      </section>

      <Separator />

      {/* Act leg: owned fixes + third-party plans */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Wrench className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-900">Act — fixes & action plans</h2>
          {chip("approval-gated", "border-stone-200 bg-stone-50 text-stone-600")}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <h3 className="mb-1 text-sm font-semibold text-stone-900">Owned-domain GEO16 fixes</h3>
            <p className="mb-3 text-[11px] text-stone-500">
              Approval flows into the supervised fix-agent ladder: proposed → approved → applied. Never autonomous.
            </p>
            {ownedFixes.length === 0 ? (
              <p className="text-xs text-stone-400">No owned-domain fix proposals yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-stone-200">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                      <th className="px-3 py-2 font-medium">Page</th>
                      <th className="px-3 py-2 font-medium">Pillars</th>
                      <th className="px-3 py-2 font-medium">Benchmark impact</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ownedFixes.map((a) => {
                      const fix = a.fixProposalJson as FixProposal | null;
                      return (
                        <>
                          <tr key={a.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                            <td className="px-3 py-2">
                              <span className="flex items-center gap-1.5 font-medium text-stone-900">
                                <ExternalLink className="h-3 w-3 shrink-0 text-stone-400" />
                                {fix?.pageUrl ?? a.sourceRef}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <span className="flex flex-wrap gap-1">
                                {(a.geo16Pillars.length > 0 ? a.geo16Pillars : [fix?.pillar].filter(Boolean) as string[]).map((p) => (
                                  chip(PILLAR_LABELS[p] ?? p, "border-stone-200 bg-stone-50 text-stone-600")
                                ))}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-[12px] text-stone-600">
                              {fix?.benchmarkImpactPct != null ? `+${fix.benchmarkImpactPct}% citations` : "—"}
                            </td>
                            <td className="px-3 py-2">{chip(a.status, ACTION_STATUS_CHIP[a.status] ?? ACTION_STATUS_CHIP.proposed)}</td>
                            <td className="px-3 py-2">
                              {canEdit && a.status === "proposed" && <ApproveActionButton id={a.id} />}
                            </td>
                          </tr>
                          {(fix?.proposedChange || fix?.rationale) && (
                            <tr key={`${a.id}-detail`} className="border-b border-stone-100 bg-stone-50/40">
                              <td colSpan={5} className="px-3 py-2">
                                {fix?.proposedChange && <p className="text-xs text-stone-600">{fix.proposedChange}</p>}
                                {fix?.rationale && <p className="mt-1 text-[11px] text-stone-400">{fix.rationale}</p>}
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <h3 className="mb-1 text-sm font-semibold text-stone-900">Third-party user action plans</h3>
            <p className="mb-3 text-[11px] text-stone-500">
              Marketr cannot edit third-party pages — these are concrete plans for you to execute. Approving
              marks a commitment; it never publishes on your behalf.
            </p>
            {thirdParty.length === 0 ? (
              <p className="text-xs text-stone-400">No third-party action plans yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-stone-200">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                      <th className="px-3 py-2 font-medium">Target</th>
                      <th className="px-3 py-2 font-medium">Expected lift</th>
                      <th className="px-3 py-2 font-medium">Deadline</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {thirdParty.map((a) => {
                      const plan = a.actionPlanJson as ThirdPartyPlan | null;
                      return (
                        <>
                          <tr key={a.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                            <td className="px-3 py-2">
                              <span className="flex items-center gap-1.5 font-medium text-stone-900">
                                <ExternalLink className="h-3 w-3 shrink-0 text-stone-400" />
                                {plan?.exactTarget ?? a.sourceRef}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-[12px] text-stone-600">
                              {(plan?.expectedLift ?? a.expectedLift) != null ? `+${Number(plan?.expectedLift ?? a.expectedLift).toFixed(1)} pts` : "—"}
                            </td>
                            <td className="px-3 py-2 text-[12px] text-stone-600">
                              {plan?.deadline ? (
                                <span className="flex items-center gap-1">
                                  <CalendarClock className="h-3 w-3" /> {plan.deadline}
                                </span>
                              ) : "—"}
                            </td>
                            <td className="px-3 py-2">{chip(a.status, ACTION_STATUS_CHIP[a.status] ?? ACTION_STATUS_CHIP.proposed)}</td>
                            <td className="px-3 py-2">
                              {canEdit && a.status === "proposed" && <ApproveActionButton id={a.id} />}
                            </td>
                          </tr>
                          {plan?.contributionAngle && (
                            <tr key={`${a.id}-detail`} className="border-b border-stone-100 bg-stone-50/40">
                              <td colSpan={5} className="px-3 py-2">
                                <p className="text-xs text-stone-600">{plan.contributionAngle}</p>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>

      <Separator />

      {/* Prompt-set manager + run trigger */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <ListOrdered className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-900">Prompt sets & runs</h2>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold text-stone-900">Versions</h3>
            {promptSets.length === 0 ? (
              <p className="text-xs text-stone-400">No prompt sets yet — create one below.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-stone-200">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                      <th className="px-3 py-2 font-medium">Version</th>
                      <th className="px-3 py-2 font-medium">Prompts</th>
                      <th className="px-3 py-2 font-medium">Created</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promptSets.map((s) => (
                      <tr key={s.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                        <td className="px-3 py-2 font-semibold text-stone-900">v{s.version}</td>
                        <td className="px-3 py-2 text-stone-600">{s.promptCount}</td>
                        <td className="px-3 py-2 text-[12px] text-stone-600">{s.createdAt.toLocaleDateString()}</td>
                        <td className="px-3 py-2">
                          {s.active ? chip("Active", "border-emerald-200 bg-emerald-50 text-emerald-700") : <span className="text-stone-400">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit && !s.active && <ActivatePromptSetButton id={s.id} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canEdit && (
              <div className="mt-4 border-t border-stone-100 pt-4">
                <h4 className="mb-2 text-xs font-semibold text-stone-900">Create new version</h4>
                <CreatePromptSetForm />
              </div>
            )}
          </div>

          <div className="rounded-xl border border-stone-200 bg-white p-4">
            <h3 className="mb-1 text-sm font-semibold text-stone-900">Weekly run trigger</h3>
            <p className="mb-3 text-[11px] text-stone-500">
              Runs the active prompt set against all four engines (N=3 reps each), then the nano-judge parses
              mention, position, sentiment, competitors, and cited sources. Official APIs only — no consumer
              chat-UI scraping. Weekly default; daily available at ~4.3× cost. Envelope ~$1–5/mo per brand
              (flagships ≈ $15–40/mo).
            </p>
            {canEdit ? (
              <TriggerRunCard hasActiveSet={hasActiveSet} brand={brand} />
            ) : (
              <p className="text-xs text-stone-400">Editor role required to start a run.</p>
            )}
            <div className="mt-4 border-t border-stone-100 pt-3 text-[11px] text-stone-500">
              <Link href="/dashboard/authority" className="font-medium text-stone-700 hover:text-stone-900">
                ← Back to Authority overview
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
