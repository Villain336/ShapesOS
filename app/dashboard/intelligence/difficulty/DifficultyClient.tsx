// Marketr — Phase 10 M5: difficulty client UI.
// Keyword table with modeled estimate, ± uncertainty band, and provenance
// badges (which authority sources fed the estimate; experimental-vs-live),
// plus the eval-bar tab showing the gate state that decides whether the
// model may replace the vendor call. House style diffed against
// app/dashboard/studio/StudioApp.tsx: dense tables (rows
// hover:bg-violet-50/40), violet primaries, Lucide icons, sub-tabs with icon
// + label (active = border-violet-600 text-violet-700), info notes
// border-stone-200 bg-stone-50.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  FlaskConical,
  ListOrdered,
  Loader2,
  Play,
  Search,
} from "lucide-react";

// ── Small atoms (StudioApp parity) ───────────────────────────────────────────

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40";
const thCls = "px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-stone-500";
const tdCls = "px-2.5 py-1.5 text-[13px] text-stone-800";
const rowCls = "border-t border-stone-100 hover:bg-violet-50/40";
const noteCls = "rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-600";

// ── Types (mirror lib/intelligence/difficulty wire shapes) ──────────────────

interface AuthoritySourceProv {
  source: "moz" | "openpagerank" | "cc_graph";
  weight: number;
  domainsCovered: number;
}

interface InputsProvenance {
  serpVendor: string;
  authoritySources: AuthoritySourceProv[];
  ccWeightCapped: boolean;
  volumeBand: string | null;
  volumeSource: string | null;
  ownAuthorityProvided: boolean;
  featureCount: number;
  aiOverviewPresent: boolean;
  modelVersion: string;
}

interface EstimateRow {
  id: string;
  keyword: string;
  locale: string;
  estimate: number;
  uncertaintyBand: [number, number];
  inputsProvenance: InputsProvenance;
  modelVersion: string;
  evaluatedAt: string;
  /** Client-side only: POST results carry this until the next GET refresh. */
  experimental?: boolean;
}

interface EvalMetrics {
  n: number;
  mae: number;
  spearman: number;
  bandCoverage: number;
}

interface GateState {
  modelVersion: string;
  evaluatedAt: string | null;
  passed: boolean;
  metrics: EvalMetrics | null;
  note: string;
}

interface GateStatus {
  replaceVendor: boolean;
  experimental: boolean;
  state: GateState;
}

const TABS = [
  { id: "estimates", label: "Estimates", icon: ListOrdered },
  { id: "eval", label: "Eval bar", icon: FlaskConical },
] as const;

type TabId = (typeof TABS)[number]["id"];

const SOURCE_LABEL: Record<AuthoritySourceProv["source"], string> = {
  moz: "moz",
  openpagerank: "openpagerank",
  cc_graph: "cc_graph",
};

function halfWidth(estimate: number, band: [number, number]): number {
  return Math.max(estimate - band[0], band[1] - estimate);
}

// ── Estimates tab ────────────────────────────────────────────────────────────

function ProvenanceCell({ p }: { p: InputsProvenance }) {
  const fed = p.authoritySources.filter((s) => s.domainsCovered > 0);
  if (fed.length === 0) return <span className="text-stone-400">no authority</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {fed.map((s) => (
        <Chip key={s.source} tone="blue">
          {SOURCE_LABEL[s.source]} · {s.domainsCovered}
        </Chip>
      ))}
      {p.ccWeightCapped && <Chip tone="amber">cc capped</Chip>}
      {p.aiOverviewPresent && <Chip tone="slate">AIO</Chip>}
    </div>
  );
}

function EstimatesTab({
  estimates,
  experimental,
  onEstimated,
}: {
  estimates: EstimateRow[];
  experimental: boolean;
  onEstimated: (rows: EstimateRow[]) => void;
}) {
  const [keywords, setKeywords] = useState("");
  const [locale, setLocale] = useState("en-US");
  const [ownDomain, setOwnDomain] = useState("");
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return estimates;
    return estimates.filter((e) => e.keyword.toLowerCase().includes(q));
  }, [estimates, filter]);

  const runEstimate = useCallback(async () => {
    const kws = keywords
      .split(/[\n,]+/)
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (kws.length === 0) {
      setError("Enter at least one keyword (comma or newline separated, max 20).");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/intelligence/difficulty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords: kws,
          locale: locale.trim() || "en-US",
          ownDomain: ownDomain.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const rows: EstimateRow[] = [];
      const failures: string[] = [];
      for (const r of data.results as Array<{
        keyword: string;
        ok: boolean;
        reason?: string;
        estimate?: number;
        uncertaintyBand?: [number, number];
        inputsProvenance?: InputsProvenance;
        experimental?: boolean;
      }>) {
        if (r.ok && r.inputsProvenance) {
          rows.push({
            id: `new-${Date.now()}-${r.keyword}`,
            keyword: r.keyword,
            locale: locale.trim() || "en-US",
            estimate: r.estimate ?? 0,
            uncertaintyBand: r.uncertaintyBand ?? [0, 100],
            inputsProvenance: r.inputsProvenance,
            modelVersion: data.modelVersion,
            evaluatedAt: new Date().toISOString(),
            experimental: r.experimental,
          });
        } else {
          failures.push(`${r.keyword}: ${r.reason ?? "failed"}`);
        }
      }
      onEstimated(rows);
      if (failures.length > 0) setError(`Some keywords failed: ${failures.join(" · ")}`);
      setKeywords("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [keywords, locale, ownDomain, onEstimated]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputCls} min-w-64 flex-1`}
          placeholder="keyword, one per line or comma-separated (max 20)"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
        />
        <input
          className={`${inputCls} w-24`}
          placeholder="en-US"
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
          aria-label="Locale"
        />
        <input
          className={`${inputCls} w-44`}
          placeholder="own domain (optional)"
          value={ownDomain}
          onChange={(e) => setOwnDomain(e.target.value)}
          aria-label="Own domain"
        />
        <button className={btnPrimary} onClick={runEstimate} disabled={running}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Estimate
        </button>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" />
          <input
            className={`${inputCls} w-48 pl-8`}
            placeholder="filter keywords…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-stone-200 bg-white">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-stone-50/60">
              <th className={thCls}>Keyword</th>
              <th className={`${thCls} text-right`}>KD</th>
              <th className={thCls}>± Band</th>
              <th className={thCls}>Volume</th>
              <th className={thCls}>Authority sources</th>
              <th className={thCls}>SERP vendor</th>
              <th className={thCls}>Status</th>
              <th className={thCls}>Evaluated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr className={rowCls}>
                <td className={`${tdCls} text-stone-500`} colSpan={8}>
                  No estimates yet — run one above. Every estimate is versioned; model bumps never rewrite history.
                </td>
              </tr>
            )}
            {filtered.map((e) => {
              const hw = halfWidth(e.estimate, e.uncertaintyBand);
              const isExperimental = e.experimental ?? experimental;
              return (
                <tr key={e.id} className={rowCls}>
                  <td className={`${tdCls} font-medium`}>{e.keyword}</td>
                  <td className={`${tdCls} text-right tabular-nums font-semibold`}>{e.estimate}</td>
                  <td className={`${tdCls} tabular-nums text-stone-600`}>
                    ±{hw} <span className="text-stone-400">[{e.uncertaintyBand[0]}–{e.uncertaintyBand[1]}]</span>
                  </td>
                  <td className={tdCls}>
                    {e.inputsProvenance.volumeBand ? (
                      <span className="tabular-nums">{e.inputsProvenance.volumeBand}</span>
                    ) : (
                      <span className="text-stone-400">unknown</span>
                    )}
                  </td>
                  <td className={tdCls}>
                    <ProvenanceCell p={e.inputsProvenance} />
                  </td>
                  <td className={tdCls}>
                    <span className="font-mono text-[12px]">{e.inputsProvenance.serpVendor}</span>
                  </td>
                  <td className={tdCls}>
                    {isExperimental ? (
                      <Chip tone="amber">experimental</Chip>
                    ) : (
                      <Chip tone="violet">model live</Chip>
                    )}
                  </td>
                  <td className={`${tdCls} whitespace-nowrap text-stone-500`}>
                    {new Date(e.evaluatedAt).toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={noteCls}>
        Until the eval bar passes, modeled values are <span className="font-medium">experimental</span> and shown
        alongside the vendor difficulty in keyword research — they never replace it. Volume is always a band
        (never a false-precision point); missing volume widens the ± band. The CC hyperlink graph is
        confidence-capped at 0.50 (quarterly, domain-level, no anchors).
      </div>
    </div>
  );
}

// ── Eval-bar tab ─────────────────────────────────────────────────────────────

const BAR_ROWS: Array<{
  name: string;
  bar: string;
  get: (m: EvalMetrics | null) => { text: string; ok: boolean } | null;
}> = [
  {
    name: "Mean absolute error vs. vendor",
    bar: "≤ 15 (0–100 scale)",
    get: (m) => (m ? { text: m.mae.toFixed(2), ok: m.mae <= 15 } : null),
  },
  {
    name: "Spearman rank correlation",
    bar: "≥ 0.70",
    get: (m) => (m ? { text: m.spearman.toFixed(3), ok: m.spearman >= 0.7 } : null),
  },
  {
    name: "Uncertainty-band coverage",
    bar: "≥ 70%",
    get: (m) =>
      m ? { text: `${(m.bandCoverage * 100).toFixed(1)}%`, ok: m.bandCoverage >= 0.7 } : null,
  },
  {
    name: "Held-out set size",
    bar: "≥ 50 keywords",
    get: (m) => (m ? { text: String(m.n), ok: m.n >= 50 } : null),
  },
];

function EvalTab({ gate, modelVersion }: { gate: GateStatus | null; modelVersion: string }) {
  const state = gate?.state;
  const metrics = state?.metrics ?? null;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Gate</div>
          <div className="mt-1 flex items-center gap-1.5">
            {gate == null ? (
              <span className="text-[13px] text-stone-400">loading…</span>
            ) : gate.replaceVendor ? (
              <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-violet-700">
                <CircleCheck className="h-4 w-4" /> open — model replaces vendor
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-amber-700">
                <CircleX className="h-4 w-4" /> closed — vendor stays
              </span>
            )}
          </div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Model version</div>
          <div className="mt-1 font-mono text-[15px] font-bold text-stone-900">{modelVersion}</div>
          <div className="mt-0.5 text-[11px] text-stone-500">a bump closes the gate until re-evaluated</div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Last live eval</div>
          <div className="mt-1 text-[13px] font-semibold text-stone-900">
            {state?.evaluatedAt ? new Date(state.evaluatedAt).toLocaleString() : "never"}
          </div>
          <div className="mt-0.5 text-[11px] text-stone-500">paid reference: DataForSEO bulk difficulty</div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Verdict</div>
          <div className="mt-1 text-[13px] font-semibold text-stone-900">
            {state == null ? "—" : state.passed ? "PASS" : "not passed"}
          </div>
          <div className="mt-0.5 text-[11px] text-stone-500">all four criteria must hold</div>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-stone-200 bg-white">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-stone-50/60">
              <th className={thCls}>Criterion</th>
              <th className={thCls}>Bar</th>
              <th className={thCls}>Current</th>
              <th className={thCls}>Result</th>
            </tr>
          </thead>
          <tbody>
            {BAR_ROWS.map((r) => {
              const cur = r.get(metrics);
              return (
                <tr key={r.name} className={rowCls}>
                  <td className={tdCls}>{r.name}</td>
                  <td className={`${tdCls} tabular-nums`}>{r.bar}</td>
                  <td className={`${tdCls} tabular-nums`}>{cur ? cur.text : <span className="text-stone-400">—</span>}</td>
                  <td className={tdCls}>
                    {cur == null ? (
                      <span className="text-stone-400">unevaluated</span>
                    ) : cur.ok ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <CircleCheck className="h-3.5 w-3.5" /> pass
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-red-700">
                        <CircleX className="h-3.5 w-3.5" /> fail
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={noteCls}>
        <span className="font-medium text-stone-700">How to evaluate.</span> The bar is checked on a held-out
        set of ≥ 50 keywords spanning the difficulty deciles, against DataForSEO{" "}
        <span className="font-mono text-[12px]">labs/bulk_keyword_difficulty</span> ($0.132/1K — ~$0.01 for the
        60-keyword set) as the paid reference. Ordering matters most: keyword research shows rankings, and a
        misordering model is worse than useless — hence the Spearman ≥ 0.70 bar.
      </div>

      <div className={noteCls}>
        <span className="font-medium text-stone-700">Run it.</span>{" "}
        <span className="font-mono text-[12px]">npx tsx scripts/eval-difficulty.mts</span> runs the CI-safe
        fixture eval (no keys, no network — guards model math, not the gate).{" "}
        <span className="font-mono text-[12px]">npx tsx scripts/eval-difficulty.mts --live --workspace &lt;id&gt; --write-state</span>{" "}
        runs the paid reference eval; <span className="font-mono text-[12px]">--write-state</span> is the only
        writer of <span className="font-mono text-[12px]">eval-state.json</span>. The gate opens only on a
        recorded PASS for the current model version.
      </div>

      {state?.note && <div className={noteCls}>{state.note}</div>}
    </div>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────

export function DifficultyClient() {
  const [tab, setTab] = useState<TabId>("estimates");
  const [estimates, setEstimates] = useState<EstimateRow[]>([]);
  const [gate, setGate] = useState<GateStatus | null>(null);
  const [modelVersion, setModelVersion] = useState("m5-v1");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/intelligence/difficulty");
      const data = await res.json();
      if (res.ok) {
        setEstimates(data.estimates ?? []);
        setGate(data.gate ?? null);
        if (data.modelVersion) setModelVersion(data.modelVersion);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const prepend = useCallback((rows: EstimateRow[]) => {
    setEstimates((prev) => [...rows, ...prev]);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-stone-200">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium ${
                active ? "border-violet-600 text-violet-700" : "border-transparent text-stone-500 hover:text-stone-800"
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading estimates…
        </div>
      ) : (
        <>
          {tab === "estimates" && (
            <EstimatesTab
              estimates={estimates}
              experimental={gate?.experimental ?? true}
              onEstimated={prepend}
            />
          )}
          {tab === "eval" && <EvalTab gate={gate} modelVersion={modelVersion} />}
        </>
      )}
    </div>
  );
}
