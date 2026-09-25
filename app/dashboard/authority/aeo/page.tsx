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
import { Badge } from "@/components/vault/shadcn/badge";
import { Progress } from "@/components/vault/shadcn/progress";
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

const ACTION_STATUS_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  proposed: "outline",
  approved: "secondary",
  applied: "default",
  done: "default",
  dismissed: "destructive",
};

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
    <div className="flex h-full flex-col gap-6 bg-[#FAFAF7] p-4 md:p-6">
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
              className="w-44 bg-white"
            />
            <button
              type="submit"
              className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 hover:border-stone-400"
            >
              Set
            </button>
          </form>
        </div>
        <div className="mt-3 flex gap-2 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
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

      {/* Per-engine cards — never a composite */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-900">Per-engine visibility</h2>
          <Badge variant="outline" className="text-[10px]">No composite score</Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {AEO_ENGINES.map((engine) => {
            const score = perEngine[engine];
            const d = deltas[engine];
            const latest = latestRunByEngine[engine];
            return (
              <div key={engine} className="rounded-xl border border-stone-200 bg-white p-4">
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-stone-900">{ENGINE_LABELS[engine]}</h3>
                  <Badge variant="secondary" className="text-[10px]">{engine}</Badge>
                </div>
                <p className="mb-3 font-mono text-[11px] text-stone-400">{ENGINE_MODELS[engine]}</p>
                {!score ? (
                  <p className="text-xs text-stone-400">No completed run yet for this engine.</p>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs text-stone-500">Mention rate</span>
                        <span className="flex items-center gap-2">
                          <Delta value={d.mentionRate} />
                          <span className="text-lg font-bold text-stone-900">{pct1(score.mentionRate)}</span>
                        </span>
                      </div>
                      <Progress value={score.mentionRate} className="mt-1 h-1.5" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-xs text-stone-500">Answer share of voice</p>
                        <p className="text-lg font-bold text-stone-900">{pct1(score.answerShareOfVoice)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-stone-500">Recommendation rate</p>
                        <p className="flex items-center gap-1.5 text-lg font-bold text-stone-900">
                          {pct1(score.recommendationRate)}
                          <Delta value={d.recommendationRate} />
                        </p>
                      </div>
                    </div>
                    <div>
                      <p className="mb-1 text-xs text-stone-500">Sentiment distribution</p>
                      <SentimentBar sentiment={score.sentiment} />
                    </div>
                    <div className="flex items-center justify-between border-t border-stone-100 pt-2 text-[11px] text-stone-400">
                      <span>
                        {score.responses} responses · {score.prompts} prompts
                      </span>
                      <span>
                        {latest
                          ? `v${latest.version} · ${latest.startedAt.toLocaleDateString()}`
                          : "—"}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
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
          <Badge variant="outline" className="text-[10px]">per engine</Badge>
        </div>
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-stone-500">
                <th className="px-4 py-2.5 font-medium">Domain</th>
                <th className="px-4 py-2.5 font-medium">Engine</th>
                <th className="px-4 py-2.5 font-medium" title="Times the domain was cited across the prompt set">
                  Citation frequency
                </th>
                <th className="px-4 py-2.5 font-medium" title="Citations per URL — how efficiently its pages get cited">
                  Citation efficiency
                </th>
                <th className="px-4 py-2.5 font-medium" title="P(brand recommended | source cited) − P(brand recommended | source not cited), per engine">
                  Co-occurrence lift
                </th>
                <th className="px-4 py-2.5 font-medium">Computed</th>
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
                  <tr key={i.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                    <td className="px-4 py-2.5 font-medium text-stone-900">{i.domain}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant="secondary" className="text-[10px]">{i.engine}</Badge>
                    </td>
                    <td className="px-4 py-2.5 font-semibold text-stone-900">{i.citationFrequency}</td>
                    <td className="px-4 py-2.5 text-stone-600">{i.citationEfficiency.toFixed(2)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`font-semibold ${i.cooccurrenceLift > 0 ? "text-emerald-700" : i.cooccurrenceLift < 0 ? "text-red-700" : "text-stone-500"}`}>
                        {liftFmt(i.cooccurrenceLift)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-stone-400">{i.computedAt.toLocaleDateString()}</td>
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
          <Badge variant="outline" className="text-[10px]">approval-gated</Badge>
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
              <ul className="space-y-3">
                {ownedFixes.map((a) => {
                  const fix = a.fixProposalJson as FixProposal | null;
                  return (
                    <li key={a.id} className="rounded-lg border border-stone-100 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 truncate text-xs font-medium text-stone-900">
                            <ExternalLink className="h-3 w-3 shrink-0 text-stone-400" />
                            {fix?.pageUrl ?? a.sourceRef}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {(a.geo16Pillars.length > 0 ? a.geo16Pillars : [fix?.pillar].filter(Boolean) as string[]).map((p) => (
                              <Badge key={p} variant="secondary" className="text-[10px]">
                                {PILLAR_LABELS[p] ?? p}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <Badge variant={ACTION_STATUS_BADGE[a.status] ?? "outline"} className="shrink-0 text-[10px]">
                          {a.status}
                        </Badge>
                      </div>
                      {fix?.proposedChange && (
                        <p className="mt-2 text-xs text-stone-600">{fix.proposedChange}</p>
                      )}
                      {fix?.rationale && (
                        <p className="mt-1 text-[11px] text-stone-400">{fix.rationale}</p>
                      )}
                      <div className="mt-2 flex items-center justify-between">
                        {fix?.benchmarkImpactPct != null && (
                          <span className="text-[11px] text-stone-500">
                            Benchmark impact: +{fix.benchmarkImpactPct}% citations (directional)
                          </span>
                        )}
                        {canEdit && a.status === "proposed" && <ApproveActionButton id={a.id} />}
                      </div>
                    </li>
                  );
                })}
              </ul>
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
              <ul className="space-y-3">
                {thirdParty.map((a) => {
                  const plan = a.actionPlanJson as ThirdPartyPlan | null;
                  return (
                    <li key={a.id} className="rounded-lg border border-stone-100 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-stone-900">
                          <ExternalLink className="h-3 w-3 shrink-0 text-stone-400" />
                          {plan?.exactTarget ?? a.sourceRef}
                        </p>
                        <Badge variant={ACTION_STATUS_BADGE[a.status] ?? "outline"} className="shrink-0 text-[10px]">
                          {a.status}
                        </Badge>
                      </div>
                      {plan?.contributionAngle && (
                        <p className="mt-2 text-xs text-stone-600">{plan.contributionAngle}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-stone-500">
                        {(plan?.expectedLift ?? a.expectedLift) != null && (
                          <span>
                            Expected lift:{" "}
                            <strong className="text-stone-800">+{Number(plan?.expectedLift ?? a.expectedLift).toFixed(1)} pts</strong>
                          </span>
                        )}
                        {plan?.deadline && (
                          <span className="flex items-center gap-1">
                            <CalendarClock className="h-3 w-3" /> Deadline {plan.deadline}
                          </span>
                        )}
                      </div>
                      {canEdit && a.status === "proposed" && (
                        <div className="mt-2">
                          <ApproveActionButton id={a.id} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
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
              <ul className="space-y-2">
                {promptSets.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-stone-100 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-stone-900">v{s.version}</span>
                      {s.active && <Badge variant="default" className="text-[10px]">Active</Badge>}
                      <span className="text-xs text-stone-500">{s.promptCount} prompts</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-stone-400">
                        {s.createdAt.toLocaleDateString()}
                      </span>
                      {canEdit && !s.active && <ActivatePromptSetButton id={s.id} />}
                    </div>
                  </li>
                ))}
              </ul>
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
