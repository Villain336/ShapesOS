// Marketr — Phase 10 M1: Rank intelligence client.
// Tabs: [Overview] [Query × page] [Winners & losers] [Sources].
// House style diffed against app/dashboard/studio/StudioApp.tsx:
// Chip atoms, inputCls/btnPrimary/btnGhost, border-b-2 violet active tabs,
// dense tables with badge columns, rows hover:bg-violet-50/40,
// filter toolbar (dropdowns + search + violet button), info notes
// border-stone-200 bg-stone-50.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Database,
  LayoutDashboard,
  Loader2,
  Plug2,
  RefreshCw,
  Table2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

// ── Atoms (mirroring StudioApp.tsx) ──────────────────────────────────────────

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

const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";

// ── Types ────────────────────────────────────────────────────────────────────

interface DeltaRow {
  page: string;
  query: string;
  deltaClicks: number;
  deltaImpressions: number;
  deltaPosition: number;
  magnitude: number;
  source: "gsc" | "paid";
}

interface RankData {
  project: { id: string; domain: string };
  windows: { pre: { start: string; end: string }; post: { start: string; end: string } };
  gsc: { connected: boolean; property: string | null };
  bigquery: { configured: boolean; reason?: string; dataset?: string; projectId?: string };
  visibility: {
    scorePre: number;
    scorePost: number;
    scoreDelta: number;
    winners: DeltaRow[];
    losers: DeltaRow[];
    improvedCount: number;
    declinedCount: number;
  } | null;
  visibilityError: string | null;
  rows: DeltaRow[];
  paidResidual: { available: boolean; reason: string };
}

interface Project {
  id: string;
  domain: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDelta(n: number, digits = 1): string {
  const v = Math.round(n * 10 ** digits) / 10 ** digits;
  return `${v > 0 ? "+" : ""}${v.toLocaleString()}`;
}

function PositionDelta({ value }: { value: number }) {
  if (value === 0) return <span className="text-stone-400">—</span>;
  const up = value < 0; // negative deltaPosition = moved UP
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className={`inline-flex items-center gap-0.5 font-medium ${up ? "text-emerald-700" : "text-red-700"}`}>
      <Icon size={12} />
      {Math.abs(Math.round(value * 10) / 10)}
    </span>
  );
}

function SourceBadge({ source }: { source: "gsc" | "paid" }) {
  return source === "gsc" ? <Chip tone="violet">GSC</Chip> : <Chip tone="amber">Paid vendor</Chip>;
}

function shortPage(page: string): string {
  try {
    const u = new URL(page);
    return u.pathname === "/" ? `${u.hostname}/` : `${u.hostname}${u.pathname}`;
  } catch {
    return page.length > 48 ? `${page.slice(0, 47)}…` : page;
  }
}

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "table", label: "Query × page", icon: Table2 },
  { id: "movers", label: "Winners & losers", icon: TrendingUp },
  { id: "sources", label: "Sources", icon: Plug2 },
] as const;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Client ───────────────────────────────────────────────────────────────────

export function RankClient({ projects }: { projects: Project[] }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("overview");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [preStart, setPreStart] = useState(() => ymd(new Date(Date.now() - 14 * 864e5)));
  const [preEnd, setPreEnd] = useState(() => ymd(new Date(Date.now() - 7 * 864e5)));
  const [postStart, setPostStart] = useState(() => ymd(new Date(Date.now() - 7 * 864e5)));
  const [postEnd, setPostEnd] = useState(() => ymd(new Date()));
  const [q, setQ] = useState("");
  const [data, setData] = useState<RankData | null>(null);
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        projectId,
        preStart,
        preEnd,
        postStart,
        postEnd,
      });
      const r = await fetch(`/api/intelligence/rank?${qs.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, preStart, preEnd, postStart, postEnd]);

  useEffect(() => {
    load();
  }, [load]);

  const pull = useCallback(async () => {
    if (!projectId) return;
    setPulling(true);
    try {
      await fetch("/api/intelligence/rank/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, granularity: "hourly" }),
      });
      await load();
    } finally {
      setPulling(false);
    }
  }, [projectId, load]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const all = data.rows;
    if (!needle) return all;
    return all.filter(
      (r) => r.query.toLowerCase().includes(needle) || r.page.toLowerCase().includes(needle),
    );
  }, [data, q]);

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.magnitude - a.magnitude),
    [rows],
  );

  return (
    <div>
      {/* Sub-tabs */}
      <div className="mb-4 flex gap-1 border-b border-stone-200">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
              tab === id
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Filter toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.domain}</option>
          ))}
        </select>
        <span className="text-[12px] text-stone-500">Pre</span>
        <input type="date" value={preStart} onChange={(e) => setPreStart(e.target.value)} className={inputCls} />
        <input type="date" value={preEnd} onChange={(e) => setPreEnd(e.target.value)} className={inputCls} />
        <span className="text-[12px] text-stone-500">Post</span>
        <input type="date" value={postStart} onChange={(e) => setPostStart(e.target.value)} className={inputCls} />
        <input type="date" value={postEnd} onChange={(e) => setPostEnd(e.target.value)} className={inputCls} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search query or page…"
          className={`${inputCls} w-44`}
        />
        <div className="ml-auto flex items-center gap-2">
          <button onClick={pull} disabled={pulling || !projectId} className={btnGhost}>
            {pulling ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Pull latest
          </button>
          <button onClick={load} disabled={loading || !projectId} className={btnPrimary}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : null}
            Compare
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {!data?.gsc.connected && !loading && (
        <div className="mb-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5 text-[13px] text-stone-600">
          Search Console isn’t connected for this project yet — bind the{" "}
          <span className="font-medium text-stone-800">google-search-console</span> connector to the
          project to make GSC the rank truth here. Paid SERP stays available for
          competitor keywords in the meantime.
        </div>
      )}

      {tab === "overview" && <OverviewTab data={data} loading={loading} />}
      {tab === "table" && <QueryPageTab rows={sortedRows} loading={loading} />}
      {tab === "movers" && <MoversTab data={data} loading={loading} />}
      {tab === "sources" && <SourcesTab data={data} loading={loading} />}
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({ data, loading }: { data: RankData | null; loading: boolean }) {
  const v = data?.visibility;
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2 font-medium">Visibility score (GSC-sourced)</th>
              <th className="px-3 py-2 font-medium">Pre window</th>
              <th className="px-3 py-2 font-medium">Post window</th>
              <th className="px-3 py-2 font-medium">Delta</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
              <td className="px-3 py-2 font-medium text-stone-900">
                Unified score <span className="font-normal text-stone-500">— same formula as paid rank checks, GSC positions instead</span>
              </td>
              <td className="px-3 py-2 text-stone-700">{loading ? "…" : (v ? v.scorePre : "—")}</td>
              <td className="px-3 py-2 text-stone-700">{loading ? "…" : (v ? v.scorePost : "—")}</td>
              <td className="px-3 py-2">
                {loading ? "…" : v ? (
                  <span className={`font-medium ${v.scoreDelta > 0 ? "text-emerald-700" : v.scoreDelta < 0 ? "text-red-700" : "text-stone-500"}`}>
                    {fmtDelta(v.scoreDelta, 0)} pts
                  </span>
                ) : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2 font-medium">Movement summary</th>
              <th className="px-3 py-2 font-medium">Page × query pairs</th>
            </tr>
          </thead>
          <tbody>
            {[
              { label: "Improved position", value: v?.improvedCount, tone: "green" as const, icon: TrendingUp },
              { label: "Declined position", value: v?.declinedCount, tone: "red" as const, icon: TrendingDown },
            ].map(({ label, value, tone, icon: Icon }) => (
              <tr key={label} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                <td className="px-3 py-2 text-stone-700">
                  <span className="inline-flex items-center gap-1.5"><Icon size={14} className={tone === "green" ? "text-emerald-600" : "text-red-600"} />{label}</span>
                </td>
                <td className="px-3 py-2"><Chip tone={tone}>{loading ? "…" : (value ?? "—")}</Chip></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data?.visibilityError && (
        <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5 text-[13px] text-stone-600">
          Visibility recompute failed: {data.visibilityError}
        </div>
      )}
    </div>
  );
}

// ── Query × page table ───────────────────────────────────────────────────────

function DeltaTable({ rows, emptyHint }: { rows: DeltaRow[]; emptyHint: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
            <th className="px-3 py-2 font-medium">Query</th>
            <th className="px-3 py-2 font-medium">Page</th>
            <th className="px-3 py-2 font-medium">Clicks Δ</th>
            <th className="px-3 py-2 font-medium">Impr. Δ</th>
            <th className="px-3 py-2 font-medium">Position Δ</th>
            <th className="px-3 py-2 font-medium">Magnitude</th>
            <th className="px-3 py-2 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.query}|${r.page}|${i}`} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
              <td className="px-3 py-2 font-medium text-stone-900">{r.query}</td>
              <td className="px-3 py-2 text-stone-600" title={r.page}>{shortPage(r.page)}</td>
              <td className="px-3 py-2 text-stone-700">{fmtDelta(r.deltaClicks, 0)}</td>
              <td className="px-3 py-2 text-stone-700">{fmtDelta(r.deltaImpressions, 0)}</td>
              <td className="px-3 py-2"><PositionDelta value={r.deltaPosition} /></td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-100">
                    <span className="block h-full rounded-full bg-violet-500" style={{ width: `${r.magnitude}%` }} />
                  </span>
                  <span className="text-[12px] text-stone-500">{r.magnitude}</span>
                </span>
              </td>
              <td className="px-3 py-2"><SourceBadge source={r.source} /></td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-[13px] text-stone-400">
                {emptyHint}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function QueryPageTab({ rows, loading }: { rows: DeltaRow[]; loading: boolean }) {
  return (
    <DeltaTable
      rows={rows}
      emptyHint={loading ? "Loading…" : "No GSC deltas for these windows — pull the latest data first."}
    />
  );
}

// ── Winners & losers ─────────────────────────────────────────────────────────

function MoversTab({ data, loading }: { data: RankData | null; loading: boolean }) {
  const v = data?.visibility;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-stone-800">
          <TrendingUp size={14} className="text-emerald-600" /> Winners
          {v && <Chip tone="green">{v.winners.length}</Chip>}
        </h3>
        <DeltaTable rows={v?.winners ?? []} emptyHint={loading ? "Loading…" : "No winners in this window."} />
      </div>
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-stone-800">
          <TrendingDown size={14} className="text-red-600" /> Losers
          {v && <Chip tone="red">{v.losers.length}</Chip>}
        </h3>
        <DeltaTable rows={v?.losers ?? []} emptyHint={loading ? "Loading…" : "No losers in this window."} />
      </div>
    </div>
  );
}

// ── Sources ──────────────────────────────────────────────────────────────────

function SourcesTab({ data, loading }: { data: RankData | null; loading: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2 font-medium">Data source</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-stone-100 hover:bg-violet-50/40">
              <td className="px-3 py-2 font-medium text-stone-900">Google Search Console</td>
              <td className="px-3 py-2">
                {loading ? "…" : data?.gsc.connected ? <Chip tone="green">Connected</Chip> : <Chip tone="slate">Not connected</Chip>}
              </td>
              <td className="px-3 py-2 text-stone-600">{data?.gsc.property ?? "Bind the google-search-console connector to this project"}</td>
            </tr>
            <tr className="border-b border-stone-100 hover:bg-violet-50/40">
              <td className="px-3 py-2 font-medium text-stone-900">BigQuery bulk export</td>
              <td className="px-3 py-2">
                {loading ? "…" : data?.bigquery.configured ? <Chip tone="green">Linked</Chip> : <Chip tone="amber">Not linked</Chip>}
              </td>
              <td className="px-3 py-2 text-stone-600">
                {data?.bigquery.configured
                  ? `${data.bigquery.projectId}:${data.bigquery.dataset}`
                  : (data?.bigquery.reason ?? "Optional — removes the 50k rows/day API cap")}
              </td>
            </tr>
            <tr className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
              <td className="px-3 py-2 font-medium text-stone-900">Paid SERP (residual)</td>
              <td className="px-3 py-2">
                {data?.paidResidual.available ? <Chip tone="amber">Available</Chip> : <Chip tone="slate">Pending M6</Chip>}
              </td>
              <td className="px-3 py-2 text-stone-600">
                {data?.paidResidual.available
                  ? "Competitor keywords, zero-impression queries, SERP-feature composition"
                  : (data?.paidResidual.reason ?? "Checking vendor status…")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5 text-[13px] text-stone-600">
        <span className="font-medium text-stone-800"><Database size={13} className="mr-1 inline" />Source badges:</span>{" "}
        rows marked <Chip tone="violet">GSC</Chip> come from Search Analytics (free, owned-site truth);{" "}
        <Chip tone="amber">Paid vendor</Chip> rows come from the licensed SERP API and only ever
        cover competitor keywords, zero-impression queries, and SERP-feature composition.
      </div>
    </div>
  );
}
