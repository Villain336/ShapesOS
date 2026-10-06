// Marketr — Phase 10 M3: AI-visibility client.
// Tabs: per-engine ranges / prompt panels / citation gaps / first-party.
// House style per AGENTS.md (StudioApp.tsx reference). Honest copy throughout:
// "estimated range," never "score."

"use client";

import { useEffect, useState } from "react";
import {
  Info,
  BarChart3,
  ListOrdered,
  Link2,
  Database,
  Play,
  Plus,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

interface PanelInfo {
  id: string;
  engine: string;
  promptSetVersion: number;
  promptCount: number;
  cadence: string;
  nReps: number;
  createdAt: string;
}

interface ActivePanel extends Omit<PanelInfo, "promptCount" | "createdAt"> {
  prompts: string[];
}

interface HonestShareJson {
  share: number;
  confidenceInterval: [number, number];
  n: number;
}

interface EngineDistributionJson {
  engine: string;
  observations: number;
  prompts: number;
  reps: number;
  mentionShare: HonestShareJson;
  stability: { stability: number; flipRate: number; n: number; confidenceInterval: [number, number] };
  unmentioned: { unmentionedShare: number; unstable: boolean; confidenceInterval: [number, number]; n: number };
  ownedCitation: HonestShareJson;
  runs: number;
}

interface SummaryJson {
  panelId: string;
  engine: string;
  promptSetVersion: number;
  promptCount: number;
  latestRunAt: string | null;
  runCount: number;
  perEngine: EngineDistributionJson[];
  leaderFlips: { flipRate: number; flips: number; pairs: number; confidenceInterval: [number, number] } | null;
  proxyDisclaimer: string;
  generatedAt: string;
}

interface GapJson {
  promptIdx: number;
  engines: string[];
  competitorDomains: string[];
  competitorUrls: string[];
  gapShare: HonestShareJson;
  handoff: {
    prompt: string;
    ownedDomain: string;
    suggestedBrief: { keyword: string; structuredFactsMissing: string[]; note: string };
    briefBuilderUrl: string;
  };
}

interface Props {
  panels: PanelInfo[];
  activePanel: ActivePanel | null;
  summary: SummaryJson | null;
  ownedDomain: string;
  brand: string;
  canEdit: boolean;
  projectId: string;
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const thCls =
  "px-3 py-2 text-left text-[0.6875rem] font-semibold uppercase tracking-wide text-muted";
const tdCls = "px-3 py-2 text-[0.8125rem] text-ink";
const tabBase =
  "flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.8125rem] font-medium";

function pct(n: number) {
  return `${(n * 100).toFixed(0)}%`;
}
function range(s: HonestShareJson) {
  return `${pct(s.confidenceInterval[0])}–${pct(s.confidenceInterval[1])}`;
}

function CiBar({ s }: { s: HonestShareJson }) {
  const [lo, hi] = s.confidenceInterval;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-28 overflow-hidden rounded-full bg-hover">
        <div
          className="absolute top-0 h-full rounded-full bg-ink"
          style={{ left: `${lo * 100}%`, width: `${Math.max(2, (hi - lo) * 100)}%` }}
        />
        <div
          className="absolute top-[-2px] h-[12px] w-[2px] bg-ink"
          style={{ left: `calc(${s.share * 100}% - 1px)` }}
        />
      </div>
      <span className="text-xs text-muted">
        {range(s)} <span className="text-subtle">(n={s.n})</span>
      </span>
    </div>
  );
}

function Chip({ tone, children }: { tone?: "violet" | "amber" | "green" | "slate" | "red"; children: React.ReactNode }) {
  void tone;
  return (
    <span className={"inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-[0.625rem] font-semibold leading-tight text-muted shadow-control"}>
      {children}
    </span>
  );
}

const TABS = [
  { id: "ranges", label: "Per-engine ranges", icon: BarChart3 },
  { id: "panels", label: "Prompt panels", icon: ListOrdered },
  { id: "gaps", label: "Citation gaps", icon: Link2 },
  { id: "firstparty", label: "First-party signals", icon: Database },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function AiVisibilityClient({ panels, activePanel, summary, ownedDomain, brand, canEdit, projectId: initialProjectId }: Props) {
  const [tab, setTab] = useState<TabId>("ranges");
  const [gaps, setGaps] = useState<GapJson[] | null>(null);
  const [gapsLoading, setGapsLoading] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [fp, setFp] = useState<any>(null);
  const [fpLoading, setFpLoading] = useState(false);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [licensedNews, setLicensedNews] = useState(false);

  async function loadGaps() {
    if (!activePanel || !ownedDomain) return;
    setGapsLoading(true);
    setGaps(null);
    try {
      const r = await fetch(
        `/api/intelligence/geo/citations?panelId=${activePanel.id}&ownedDomain=${encodeURIComponent(ownedDomain)}&projectId=${encodeURIComponent(projectId)}`,
      );
      const d = await r.json();
      setGaps(d.gaps ?? []);
    } catch {
      setGaps([]);
    } finally {
      setGapsLoading(false);
    }
  }

  useEffect(() => {
    if (tab !== "gaps" || gaps !== null || gapsLoading) return;
    loadGaps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function triggerRun(form: HTMLFormElement) {
    const fd = new FormData(form);
    setRunMsg("Starting run…");
    try {
      const res = await fetch("/api/intelligence/geo/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          panelId: fd.get("panelId"),
          brand: fd.get("brand"),
          engines: fd.getAll("engines"),
        }),
      });
      const d = await res.json();
      setRunMsg(
        d.started
          ? `Run ${d.runId} started against official APIs. Unconfigured engines are skipped, never faked — refresh the summary when it completes.`
          : `Run failed: ${d.error ?? "unknown error"}`,
      );
    } catch (e) {
      setRunMsg(`Run failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function loadFirstParty() {
    if (!brand) return;
    setFpLoading(true);
    try {
      const r = await fetch(
        `/api/intelligence/geo/first-party?projectId=${encodeURIComponent(projectId)}&brand=${encodeURIComponent(brand)}&brandDomain=${encodeURIComponent(ownedDomain)}&licensedNews=${licensedNews ? "1" : "0"}`,
      );
      setFp(await r.json());
    } catch {
      setFp({ error: "Failed to load first-party signals." });
    } finally {
      setFpLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      {/* Header */}
      <div>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-ink">
              AI visibility — honest intelligence
            </h1>
            <p className="mt-0.5 max-w-3xl text-[0.8125rem] text-muted">
              Versioned buyer-prompt panels run against official LLM APIs (N reps), reported as
              per-engine estimated ranges with confidence intervals. No single AI-visibility
              score exists here by design.
            </p>
          </div>
          <form action="/dashboard/intelligence/ai-visibility" method="GET" className="flex flex-wrap items-center gap-2">
            <input
              name="ownedDomain"
              defaultValue={ownedDomain}
              placeholder="Brand domain (acme.com)"
              className={`${inputCls} w-44`}
            />
            <input
              name="brand"
              defaultValue={brand}
              placeholder="Brand name"
              className={`${inputCls} w-36`}
            />
            <input
              name="projectId"
              defaultValue={projectId}
              placeholder="Project id (optional)"
              title="Project that citation-gap briefs belong to"
              className={`${inputCls} w-40`}
            />
            <button type="submit" className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-hover">
              Set
            </button>
          </form>
        </div>
        <div className="mt-3 flex gap-2 rounded-xl border border-line bg-canvas p-3 text-xs text-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong>API proxy of consumer surfaces</strong> — per-engine spread is the metric.
            AI Overviews shift ~70% on repeat runs and cross-engine citation overlap is ~11%;
            every figure below is an <strong>estimated range</strong> (Wilson 95% CI) with its
            sample size, never a point score.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`${tabBase} ${
              tab === t.id
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Per-engine ranges ─────────────────────────────────────────── */}
      {tab === "ranges" && (
        <div className="flex flex-col gap-4">
          {!ownedDomain && (
            <div className="flex items-start gap-2.5 rounded-xl bg-needs p-4 text-sm text-ink">
              <span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0 [--aos-shape-size:14px]" style={{ color: "inherit" }} aria-hidden />
              <span>Set your brand domain above to compute citation coverage and ranges.</span>
            </div>
          )}
          {!summary ? (
            <div className="rounded-xl border border-line bg-white p-6 text-sm text-muted">
              {panels.length === 0
                ? "No prompt panels yet — create one in the Prompt panels tab."
                : "No observations yet — trigger a run in the Prompt panels tab."}
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-xl border border-line bg-white">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-line bg-canvas">
                      <th className={thCls}>Engine</th>
                      <th className={thCls}>Obs.</th>
                      <th className={thCls}>Mention estimated range</th>
                      <th className={thCls}>N-rep stability</th>
                      <th className={thCls}>Unmentioned</th>
                      <th className={thCls}>Owned-citation range</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.perEngine.map((e) => (
                      <tr key={e.engine} className="border-b border-line last:border-0 hover:bg-hover-paper">
                        <td className={`${tdCls} font-medium capitalize`}>{e.engine}</td>
                        <td className={tdCls}>{e.observations}</td>
                        <td className={tdCls}>
                          <CiBar s={e.mentionShare} />
                        </td>
                        <td className={tdCls}>
                          <span className="font-medium">{pct(e.stability.stability)}</span>{" "}
                          <span className="text-xs text-subtle">(n={e.stability.n} reps)</span>
                        </td>
                        <td className={tdCls}>
                          <div className="flex items-center gap-2">
                            <span>{pct(e.unmentioned.unmentionedShare)}</span>
                            {e.unmentioned.unstable ? (
                              <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-needs px-2 py-0.5 text-[0.625rem] font-semibold leading-tight text-ink">
                                <span className="aos-shape aos-shape--needs aos-shape--edged [--aos-shape-size:9px]" style={{ color: "inherit" }} aria-hidden />
                                unstable &gt;30%
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-ink">
                                <CheckCircle2 className="h-3 w-3" /> stable
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={tdCls}>
                          <CiBar s={e.ownedCitation} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-muted">
                <span className="rounded-xl border border-line bg-canvas px-3 py-2">
                  Runs: <strong>{summary.runCount}</strong>
                  {summary.latestRunAt && <> · latest {new Date(summary.latestRunAt).toLocaleString()}</>}
                </span>
                <span className="rounded-xl border border-line bg-canvas px-3 py-2">
                  Leader-flip rate:{" "}
                  <strong>
                    {summary.leaderFlips ? pct(summary.leaderFlips.flipRate) : "—"}
                  </strong>
                  {summary.leaderFlips && (
                    <span className="text-subtle">
                      {" "}({summary.leaderFlips.flips}/{summary.leaderFlips.pairs} run-pairs · CI{" "}
                      {range({ share: 0, confidenceInterval: summary.leaderFlips.confidenceInterval, n: summary.leaderFlips.pairs })})
                    </span>
                  )}
                  {!summary.leaderFlips && <span className="text-subtle"> (needs ≥2 runs)</span>}
                </span>
                <span className="rounded-xl border border-line bg-canvas px-3 py-2">
                  Panel v{summary.promptSetVersion} · {summary.promptCount} frozen prompts
                </span>
              </div>
              <p className="text-xs text-subtle">{summary.proxyDisclaimer}</p>
            </>
          )}
        </div>
      )}

      {/* ── Prompt panels ─────────────────────────────────────────────── */}
      {tab === "panels" && (
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-line bg-white">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line bg-canvas">
                  <th className={thCls}>Engine</th>
                  <th className={thCls}>Version</th>
                  <th className={thCls}>Prompts</th>
                  <th className={thCls}>Cadence</th>
                  <th className={thCls}>Reps</th>
                  <th className={thCls}>Created</th>
                </tr>
              </thead>
              <tbody>
                {panels.length === 0 && (
                  <tr>
                    <td colSpan={6} className={`${tdCls} text-subtle`}>
                      No panels yet. Panels are frozen at creation — to change prompts, create a new version.
                    </td>
                  </tr>
                )}
                {panels.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className={`${tdCls} font-medium capitalize`}>{p.engine}</td>
                    <td className={tdCls}>v{p.promptSetVersion}</td>
                    <td className={tdCls}>{p.promptCount}</td>
                    <td className={tdCls}>{p.cadence}</td>
                    <td className={tdCls}>{p.nReps}</td>
                    <td className={`${tdCls} text-muted`}>{new Date(p.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canEdit && (
            <div className="grid gap-4 md:grid-cols-2">
              <form
                className="flex flex-col gap-3 rounded-xl border border-line bg-white p-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const prompts = String(fd.get("prompts") ?? "").split("\n");
                  const res = await fetch("/api/intelligence/geo/panels", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      engine: fd.get("engine"),
                      prompts,
                      nReps: Number(fd.get("nReps") ?? 3),
                    }),
                  });
                  const d = await res.json();
                  setRunMsg(res.ok ? `Panel v${d.panel.promptSetVersion} frozen for ${d.panel.engine}.` : `Panel failed: ${d.error}`);
                  if (res.ok) window.location.reload();
                }}
              >
                <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Plus className="h-4 w-4" /> New frozen panel (12–25 buyer prompts)
                </h3>
                <select name="engine" className={inputCls} defaultValue="openai">
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="perplexity">Perplexity</option>
                </select>
                <textarea
                  name="prompts"
                  rows={6}
                  placeholder={"One buyer prompt per line — real questions from sales calls and support tickets."}
                  className={inputCls}
                />
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted">Reps per prompt</label>
                  <input name="nReps" type="number" min={1} max={10} defaultValue={3} className={`${inputCls} w-20`} />
                  <button type="submit" className={btnPrimary}>Freeze panel</button>
                </div>
              </form>

              <form
                className="flex flex-col gap-3 rounded-xl border border-line bg-white p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  triggerRun(e.currentTarget);
                }}
              >
                <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Play className="h-4 w-4" /> Trigger panel run
                </h3>
                <select name="panelId" className={inputCls} defaultValue={panels[0]?.id ?? ""}>
                  {panels.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.engine} · v{p.promptSetVersion} · {p.promptCount} prompts
                    </option>
                  ))}
                </select>
                <input name="brand" defaultValue={brand} placeholder="Brand name for matching" className={inputCls} />
                <div className="flex flex-wrap gap-3 text-[0.8125rem] text-muted">
                  {["openai", "anthropic", "gemini", "perplexity"].map((eng) => (
                    <label key={eng} className="flex items-center gap-1.5 capitalize">
                      <input type="checkbox" name="engines" value={eng} defaultChecked className="accent-ink" />
                      {eng}
                    </label>
                  ))}
                </div>
                <div>
                  <button type="submit" className={btnPrimary}>Run panel</button>
                </div>
                {runMsg && <p className="text-xs text-muted">{runMsg}</p>}
                <p className="text-[0.6875rem] text-subtle">
                  Official APIs only (BYO keys). Engines without a key are skipped, never faked. Every
                  call is metered (ai_prompt).
                </p>
              </form>
            </div>
          )}

          {activePanel && (
            <div className="rounded-xl border border-line bg-canvas p-4">
              <h3 className="text-sm font-semibold text-ink">
                Active panel — {activePanel.engine} · v{activePanel.promptSetVersion} (frozen)
              </h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[0.8125rem] text-muted">
                {activePanel.prompts.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {/* ── Citation gaps ─────────────────────────────────────────────── */}
      {tab === "gaps" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="Project id (content briefs land in this project)"
              className={`${inputCls} w-72`}
            />
            <button onClick={loadGaps} disabled={gapsLoading || !activePanel || !ownedDomain} className={btnGhost}>
              Reload gaps
            </button>
            <span className="text-[0.6875rem] text-subtle">
              “Build brief” opens the project&apos;s content engine with the gap prefilled.
            </span>
          </div>
          {gapsLoading && <p className="text-sm text-muted">Analyzing citations…</p>}
          {gaps !== null && !gapsLoading && gaps.length === 0 && (
            <div className="rounded-xl border border-line bg-white p-6 text-sm text-muted">
              No citation gaps detected — or no observations yet. Gaps appear where engines cite
              competitor domains but never your domain.
            </div>
          )}
          {gaps !== null && gaps.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-line bg-white">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-line bg-canvas">
                    <th className={thCls}>Buyer prompt</th>
                    <th className={thCls}>Engines</th>
                    <th className={thCls}>Cited instead of you</th>
                    <th className={thCls}>Gap range</th>
                    <th className={thCls}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((g) => (
                    <tr key={g.promptIdx} className="border-b border-line align-top last:border-0 hover:bg-hover-paper">
                      <td className={`${tdCls} max-w-xs`}>{g.handoff.prompt}</td>
                      <td className={tdCls}>
                        <div className="flex flex-wrap gap-1">
                          {g.engines.map((e) => (
                            <Chip key={e} tone="violet">{e}</Chip>
                          ))}
                        </div>
                      </td>
                      <td className={tdCls}>
                        <div className="flex flex-col gap-0.5 text-xs">
                          {g.competitorDomains.slice(0, 4).map((d) => (
                            <span key={d} className="font-mono text-muted">{d}</span>
                          ))}
                        </div>
                      </td>
                      <td className={tdCls}>
                        <CiBar s={g.gapShare} />
                      </td>
                      <td className={tdCls}>
                        <a
                          href={g.handoff.briefBuilderUrl}
                          className="inline-flex items-center gap-1 text-[0.8125rem] font-medium text-ink"
                        >
                          Build brief <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                        <p className="mt-1 max-w-[220px] text-[0.6875rem] text-subtle">
                          Missing: {g.handoff.suggestedBrief.structuredFactsMissing.slice(0, 2).join("; ")}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── First-party signals ───────────────────────────────────────── */}
      {tab === "firstparty" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="Project id (for GSC snapshots)"
              className={`${inputCls} w-64`}
            />
            <button onClick={loadFirstParty} disabled={fpLoading || !brand} className={btnPrimary}>
              Load first-party signals
            </button>
            <label className="flex items-center gap-1.5 text-[0.8125rem] text-muted">
              <input
                type="checkbox"
                checked={licensedNews}
                onChange={(e) => setLicensedNews(e.target.checked)}
                className="accent-ink"
              />
              Include licensed news (metered)
            </label>
            {!brand && <span className="text-xs text-subtle">Set a brand name above first.</span>}
          </div>
          <p className="text-[0.6875rem] text-subtle">
            Licensed news is off by default — it requires M3_LICENSED_NEWS_PROVIDER=newsapi and
            M3_NEWSAPI_KEY on the server. When enabled, every query is metered via M6.
          </p>
          {fp && !fp.error && (
            <>
              <div className="overflow-hidden rounded-xl border border-line bg-white">
                <div className="border-b border-line bg-canvas px-4 py-2 text-[0.8125rem] font-semibold text-ink">
                  GSC — AI Overview impressions
                </div>
                {fp.gsc.noAioRowsFlagged ? (
                  <p className="p-4 text-[0.8125rem] text-muted">{fp.gsc.note}</p>
                ) : (
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-line bg-canvas">
                        <th className={thCls}>Window</th>
                        <th className={thCls}>Impressions</th>
                        <th className={thCls}>Clicks</th>
                        <th className={thCls}>Queries</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fp.gsc.windows.map((w: any) => (
                        <tr key={w.windowStart} className="border-b border-line last:border-0 hover:bg-hover-paper">
                          <td className={`${tdCls} text-muted`}>
                            {new Date(w.windowStart).toLocaleDateString()} → {new Date(w.windowEnd).toLocaleDateString()}
                          </td>
                          <td className={tdCls}>{w.impressions.toLocaleString()}</td>
                          <td className={tdCls}>{w.clicks.toLocaleString()}</td>
                          <td className={tdCls}>{w.queries}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="rounded-xl border border-line bg-canvas p-4">
                <h3 className="text-sm font-semibold text-ink">GA4 — AI-referrer traffic</h3>
                <p className="mt-1 text-[0.8125rem] text-muted">{fp.ga4.note}</p>
                {fp.ga4.perHost.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {fp.ga4.perHost.map((h: any) => (
                      <Chip key={h.host} tone="slate">{h.host}: {h.sessions.toLocaleString()} sessions</Chip>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-line bg-canvas p-4">
                <h3 className="text-sm font-semibold text-ink">AI-crawler activity in your server logs</h3>
                <p className="mt-1 text-[0.8125rem] text-muted">{fp.crawlerLogs.note}</p>
                <a href={fp.crawlerLogs.docs} className="mt-1 inline-flex items-center gap-1 text-[0.8125rem] font-medium text-ink">
                  Log-shipping guide <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>

              {fp.brandedMentions?.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-line bg-white">
                  <div className="border-b border-line bg-canvas px-4 py-2 text-[0.8125rem] font-semibold text-ink">
                    Branded mentions — GDELT + CC-NEWS
                    {fp.brandedMentions.some((s: any) => s.source === "licensed-news") && " + licensed news"}
                  </div>
                  {fp.brandedMentions.map((src: any, i: number) => (
                    <div key={i} className="border-b border-line p-4 last:border-0">
                      <div className="flex items-center gap-2 text-[0.8125rem] font-medium text-ink">
                        {src.ok ? (
                          <Chip>{src.source}</Chip>
                        ) : (
                          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-failed-tint px-2 py-0.5 text-[0.625rem] font-semibold leading-tight text-failed-text">
                            <span className="size-2 rounded-[2px] bg-failed" aria-hidden />
                            {src.source}
                          </span>
                        )}
                        {src.ok ? `${src.hits.length} hits` : `failed: ${src.error}`}
                      </div>
                      {src.ok && src.hits.length > 0 && (
                        <ul className="mt-2 space-y-1 text-[0.8125rem]">
                          {src.hits.slice(0, 10).map((h: any, j: number) => (
                            <li key={j}>
                              <a href={h.url} target="_blank" rel="noreferrer" className="text-ink">
                                {h.title}
                              </a>{" "}
                              <span className="text-xs text-subtle">{h.domain}{h.publishedAt ? ` · ${h.publishedAt}` : ""}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-1 text-[0.6875rem] text-subtle">{src.note}</p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {fp?.error && <p className="text-sm text-failed-text">{fp.error}</p>}
        </div>
      )}
    </div>
  );
}
