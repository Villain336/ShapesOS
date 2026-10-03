// Marketr — local SEO tabbed UI (milestone 16).
// Client island: geo-grids (create, cost-previewed runs, heatmap + diff),
// competitors (add, snapshot cards, cost-previewed refresh), reviews
// (summary, filters, mark responded, ingest). GBP surfaces are flag-gated
// backend-side and intentionally not rendered here.

"use client";

import { useEffect, useState } from "react";
import { MapPinned, Crosshair, Star, TrendingUp, TrendingDown, Check } from "lucide-react";
import { diffGridRuns } from "@/lib/local/grid";
import {
  estimateCompetitorRefreshCost,
  estimateGridRunCost,
  estimateReviewsIngestCost,
  MAX_GRID_SIZE,
  MIN_GRID_SIZE,
} from "@/lib/seo/local-cost";
import { confirmAction } from "@/lib/ui/feedback";
import { closeOnEscape } from "@/lib/ui/keyboard";

export interface LocalGridRow {
  id: string;
  name: string;
  keyword: string;
  businessName: string;
  centerLat: number;
  centerLng: number;
  radiusMiles: number;
  gridSize: number;
  schedule: string;
  enabled: boolean;
  lastRunAt: string | null;
  runCount: number;
  latest: {
    runAt: string;
    coveragePct: number;
    avgPosition: number | null;
    cells: number;
    mock: boolean;
  } | null;
}

export interface GridCellResult {
  row: number;
  col: number;
  lat: number;
  lng: number;
  position: number | null;
  topBusiness: string | null;
}

export interface GridResultRow {
  id: string;
  runAt: string;
  cells: GridCellResult[];
  coveragePct: number;
  avgPosition: number | null;
  costUsd: number;
  mock: boolean;
}

export interface CompetitorSnapshotRow {
  id: string;
  date: string;
  rating: number | null;
  reviewCount: number | null;
  categories: string[];
  address: string | null;
  mock: boolean;
}

export interface CompetitorRow {
  id: string;
  businessName: string;
  placeId: string | null;
  domain: string | null;
  lat: number | null;
  lng: number | null;
  enabled: boolean;
  lastSnapshotAt: string | null;
  snapshots: CompetitorSnapshotRow[];
}

export interface ReviewRow {
  id: string;
  externalId: string;
  businessName: string;
  author: string | null;
  rating: number | null;
  text: string | null;
  publishedAt: string | null;
  sentiment: "pos" | "neu" | "neg";
  responded: boolean;
  mock: boolean;
}

export interface ReviewSummaryRow {
  avgRating: number | null;
  count: number;
  posCount: number;
  neuCount: number;
  negCount: number;
  topThemes: Array<{ theme: string; count: number }>;
  periodStart: string;
}

interface Props {
  projectId: string;
  canEdit: boolean;
  initialGrids: LocalGridRow[];
  initialCompetitors: CompetitorRow[];
  reviewSummary: ReviewSummaryRow | null;
  sentimentCounts: Record<string, number>;
  spend: { usedUsd: number; capUsd: number };
}

const inputCls =
  "w-full rounded-md border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm text-zinc-900 placeholder-zinc-500 focus:border-accent focus:outline-none";
const btnPrimary =
  "rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";
const btnSecondary =
  "rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-800 hover:border-zinc-400 disabled:opacity-50";
const cardCls = "rounded-lg border border-zinc-300 bg-white p-4";

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-md border border-red-200/30 bg-red-500/10 px-4 py-2 text-sm text-red-700">
      {message}
    </div>
  );
}

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="presentation"
      onClick={onClose}
      onKeyDown={closeOnEscape(onClose)}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-lg border border-zinc-200 bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function cellColor(position: number | null): string {
  if (position == null || position > 10) return "bg-red-500/80 hover:bg-red-600";
  if (position <= 3) return "bg-green-500/80 hover:bg-green-600";
  return "bg-yellow-500/80 hover:bg-yellow-500";
}

export function Heatmap({ cells, gridSize }: { cells: GridCellResult[]; gridSize: number }) {
  const byCell = new Map(cells.map((c) => [`${c.row}:${c.col}`, c]));
  const rows = [];
  for (let r = 0; r < gridSize; r++) {
    const cols = [];
    for (let c = 0; c < gridSize; c++) {
      const cell = byCell.get(`${r}:${c}`);
      const tip = cell
        ? `Row ${r + 1}, col ${c + 1}\n${
            cell.position != null ? `Your position: #${cell.position}` : "Not in top 10"
          }${cell.topBusiness ? `\nTop business: ${cell.topBusiness}` : ""}`
        : `Row ${r + 1}, col ${c + 1}\nNo data`;
      cols.push(
        <div
          key={c}
          title={tip}
          className={`aspect-square rounded-sm ${cell ? cellColor(cell.position) : "bg-zinc-100"}`}
        />,
      );
    }
    rows.push(
      <div key={r} className="grid gap-1" style={{ gridTemplateColumns: `repeat(${gridSize}, 1fr)` }}>
        {cols}
      </div>,
    );
  }
  return (
    <div>
      <div className="flex flex-col gap-1">{rows}</div>
      <div className="mt-2 flex items-center gap-4 text-xs text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-green-500/80" /> Top 3
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-yellow-500/80" /> Top 10
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-red-500/80" /> Outside top 10
        </span>
        <span className="text-zinc-500">Hover a cell for position + top business.</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Geo-grids panel
// ---------------------------------------------------------------------------

function GridsPanel({ projectId, canEdit, initialGrids, spend }: Pick<Props, "projectId" | "canEdit" | "initialGrids" | "spend">) {
  const [grids, setGrids] = useState(initialGrids);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "",
    keyword: "",
    businessName: "",
    centerLat: "",
    centerLng: "",
    radiusMiles: "5",
    gridSize: "5",
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, GridResultRow[]>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [preview, setPreview] = useState<null | {
    gridId: string;
    gridName: string;
    data: {
      providerName: string;
      isLive: boolean;
      cells: number;
      estimatedCostUsd: number;
      spendUsedUsd: number;
      spendCapUsd: number;
      withinCap: boolean;
      blockedReason: string | null;
    };
  }>(null);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const newGridCells = Math.pow(Number(form.gridSize) || 5, 2);

  async function refreshGrids() {
    const res = await fetch(`/api/local/grids?projectId=${projectId}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Failed to load grids");
    setGrids(json.grids);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/local/grids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          name: form.name,
          keyword: form.keyword,
          businessName: form.businessName,
          centerLat: Number(form.centerLat),
          centerLng: Number(form.centerLng),
          radiusMiles: Number(form.radiusMiles),
          gridSize: Number(form.gridSize),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create grid");
      setShowCreate(false);
      setForm({ name: "", keyword: "", businessName: "", centerLat: "", centerLng: "", radiusMiles: "5", gridSize: "5" });
      await refreshGrids();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create grid");
    } finally {
      setCreating(false);
    }
  }

  async function toggleDetail(grid: LocalGridRow) {
    if (expandedId === grid.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(grid.id);
    if (detail[grid.id]) return;
    setLoadingDetail(grid.id);
    setError(null);
    try {
      const res = await fetch(`/api/local/grids/${grid.id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load results");
      setDetail((d) => ({ ...d, [grid.id]: json.results as GridResultRow[] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load results");
    } finally {
      setLoadingDetail(null);
    }
  }

  async function openRunPreview(grid: LocalGridRow) {
    setError(null);
    try {
      const res = await fetch(`/api/local/grids/${grid.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to preview run");
      setPreview({ gridId: grid.id, gridName: grid.name, data: json.preview });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview run");
    }
  }

  async function confirmRun() {
    if (!preview) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/local/grids/${preview.gridId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? json.result?.note ?? "Run failed");
      setPreview(null);
      // Invalidate cached detail so the heatmap refetches fresh results.
      setDetail((d) => {
        const next = { ...d };
        delete next[preview.gridId];
        return next;
      });
      setExpandedId(preview.gridId);
      await refreshGrids();
      const res2 = await fetch(`/api/local/grids/${preview.gridId}`);
      const json2 = await res2.json();
      if (res2.ok) setDetail((d) => ({ ...d, [preview.gridId]: json2.results as GridResultRow[] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete(grid: LocalGridRow) {
    if (!await confirmAction(`Delete grid "${grid.name}" and all its run history?`)) return;
    setDeleting(grid.id);
    setError(null);
    try {
      const res = await fetch(`/api/local/grids/${grid.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to delete grid");
      await refreshGrids();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete grid");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ErrorBanner message={error} />
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Maps SERP position sampled at each cell around a center point. Spend this month:{" "}
          <span className="text-zinc-800">{fmtUsd(spend.usedUsd)} / {fmtUsd(spend.capUsd)}</span>
        </p>
        {canEdit && (
          <button className={btnSecondary} onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? "Cancel" : "+ New grid"}
          </button>
        )}
      </div>

      {showCreate && canEdit && (
        <form onSubmit={handleCreate} className={`${cardCls} grid grid-cols-1 gap-3 md:grid-cols-3`}>
          <input className={inputCls} placeholder="Grid name (e.g. Downtown core)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
          <input className={inputCls} placeholder="Keyword (e.g. plumber near me)" value={form.keyword} onChange={(e) => setForm({ ...form, keyword: e.target.value })} required maxLength={200} />
          <input className={inputCls} placeholder="Business name on Google" value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} required maxLength={200} />
          <input className={inputCls} type="number" step="any" placeholder="Center latitude" value={form.centerLat} onChange={(e) => setForm({ ...form, centerLat: e.target.value })} required />
          <input className={inputCls} type="number" step="any" placeholder="Center longitude" value={form.centerLng} onChange={(e) => setForm({ ...form, centerLng: e.target.value })} required />
          <div className="flex gap-3">
            <input className={inputCls} type="number" step="0.1" min={0.1} max={100} placeholder="Radius (mi)" value={form.radiusMiles} onChange={(e) => setForm({ ...form, radiusMiles: e.target.value })} title="Radius in miles" />
            <select className={inputCls} value={form.gridSize} onChange={(e) => setForm({ ...form, gridSize: e.target.value })} title="Grid size">
              {Array.from({ length: MAX_GRID_SIZE - MIN_GRID_SIZE + 1 }, (_, i) => MIN_GRID_SIZE + i).map((n) => (
                <option key={n} value={n}>{n}×{n}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-3 flex items-center justify-between">
            <p className="text-xs text-zinc-500">
              Estimated cost per run: <span className="text-zinc-500">{fmtUsd(estimateGridRunCost(newGridCells))}</span> ({newGridCells} cells)
            </p>
            <button type="submit" className={btnPrimary} disabled={creating}>
              {creating ? "Creating…" : "Create grid"}
            </button>
          </div>
        </form>
      )}

      {grids.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
          No geo-grids yet. Create one to start sampling Maps positions around your market.
        </div>
      ) : (
        grids.map((grid) => {
          const results = detail[grid.id];
          const selected = results && results.length > 0 ? results[0] : null;
          const prev = results && results.length > 1 ? results[1] : null;
          return (
            <div key={grid.id} className={cardCls}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-zinc-900">{grid.name}</h3>
                  <p className="mt-0.5 text-sm text-zinc-500">
                    “{grid.keyword}” · {grid.businessName} · {grid.gridSize}×{grid.gridSize} · {grid.radiusMiles}mi radius ·{" "}
                    {grid.centerLat.toFixed(4)}, {grid.centerLng.toFixed(4)} · {grid.schedule}
                    {grid.enabled ? "" : " · paused"}
                  </p>
                  {grid.latest ? (
                    <p className="mt-1 text-sm text-zinc-500">
                      Latest run {fmtDate(grid.latest.runAt)}:{" "}
                      <span className="font-medium">{grid.latest.coveragePct.toFixed(0)}% coverage</span>
                      {grid.latest.avgPosition != null && (
                        <>, avg position <span className="font-medium">#{grid.latest.avgPosition.toFixed(1)}</span></>
                      )}
                      {grid.latest.mock && <span className="ml-2 text-xs text-zinc-500">(mock)</span>}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-zinc-500">No runs yet.</p>
                  )}
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <button className={btnSecondary} onClick={() => toggleDetail(grid)}>
                      {expandedId === grid.id ? "Hide results" : "Results"}
                    </button>
                    <button className={btnPrimary} onClick={() => openRunPreview(grid)}>
                      Run now
                    </button>
                    <button
                      className="rounded-md border border-red-200/40 px-3 py-2 text-sm font-medium text-red-700 hover:border-red-300 disabled:opacity-50"
                      onClick={() => handleDelete(grid)}
                      disabled={deleting === grid.id}
                    >
                      {deleting === grid.id ? "…" : "Delete"}
                    </button>
                  </div>
                )}
              </div>

              {expandedId === grid.id && (
                <div className="mt-4 border-t border-zinc-200 pt-4">
                  {loadingDetail === grid.id ? (
                    <p className="text-sm text-zinc-500">Loading results…</p>
                  ) : results && results.length > 0 && selected ? (
                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <h4 className="text-sm font-medium text-zinc-800">
                            Heatmap — {fmtDate(selected.runAt)}
                            {selected.mock && <span className="ml-2 text-xs text-zinc-500">(mock)</span>}
                          </h4>
                          {results.length > 1 && (
                            <select
                              className="rounded-md border border-zinc-200 bg-zinc-100 px-2 py-1 text-xs text-zinc-800"
                              onChange={(e) => {
                                const r = results.find((x) => x.id === e.target.value);
                                if (r) setDetail((d) => ({ ...d, [grid.id]: [r, ...results.filter((x) => x.id !== r.id)] }));
                              }}
                              value={selected.id}
                              title="Compare a different run"
                            >
                              {results.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {fmtDate(r.runAt)}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                        <Heatmap cells={selected.cells} gridSize={grid.gridSize} />
                      </div>
                      <div className="flex flex-col gap-3">
                        <div className="grid grid-cols-3 gap-3">
                          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                            <p className="text-xs uppercase tracking-widest text-zinc-500">Coverage</p>
                            <p className="mt-1 text-xl font-semibold">{selected.coveragePct.toFixed(0)}%</p>
                          </div>
                          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                            <p className="text-xs uppercase tracking-widest text-zinc-500">Avg position</p>
                            <p className="mt-1 text-xl font-semibold">
                              {selected.avgPosition != null ? `#${selected.avgPosition.toFixed(1)}` : "—"}
                            </p>
                          </div>
                          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                            <p className="text-xs uppercase tracking-widest text-zinc-500">Run cost</p>
                            <p className="mt-1 text-xl font-semibold">{fmtUsd(selected.costUsd)}</p>
                          </div>
                        </div>
                        {prev && (() => {
                          const delta = diffGridRuns(
                            { cells: prev.cells.length, coveragePct: prev.coveragePct, avgPosition: prev.avgPosition },
                            { cells: selected.cells.length, coveragePct: selected.coveragePct, avgPosition: selected.avgPosition },
                          );
                          return (
                            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                              <p className="text-xs uppercase tracking-widest text-zinc-500">
                                vs previous run ({fmtDate(prev.runAt)})
                              </p>
                              <p className="mt-1 text-sm text-zinc-500">
                                Coverage{" "}
                                <span className={delta.coverageDeltaPct >= 0 ? "text-green-700" : "text-red-700"}>
                                  {delta.coverageDeltaPct >= 0 ? "+" : ""}{delta.coverageDeltaPct.toFixed(1)}pp
                                </span>
                                {delta.avgPositionDelta != null && (
                                  <>
                                    {" "}· Avg position{" "}
                                    <span className={`inline-flex items-center gap-0.5 ${delta.avgPositionDelta >= 0 ? "text-green-700" : "text-red-700"}`}>
                                      {delta.avgPositionDelta >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{Math.abs(delta.avgPositionDelta).toFixed(1)}
                                    </span>
                                  </>
                                )}
                              </p>
                            </div>
                          );
                        })()}
                        <div>
                          <p className="mb-1 text-xs uppercase tracking-widest text-zinc-500">Run history</p>
                          <ul className="flex flex-col gap-1 text-sm text-zinc-500">
                            {results.map((r) => (
                              <li key={r.id} className="flex justify-between">
                                <span>{fmtDate(r.runAt)}{r.mock ? " (mock)" : ""}</span>
                                <span>{r.coveragePct.toFixed(0)}% · {r.avgPosition != null ? `#${r.avgPosition.toFixed(1)}` : "—"} · {fmtUsd(r.costUsd)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-500">No results yet — run the grid to generate its first heatmap.</p>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      {preview && (
        <Modal onClose={() => !running && setPreview(null)}>
          <h3 className="text-lg font-semibold">Run “{preview.gridName}”?</h3>
          <div className="mt-4 flex flex-col gap-2 text-sm">
            <div className="flex justify-between"><span className="text-zinc-500">Cells</span><span>{preview.data.cells}</span></div>
            <div className="flex justify-between"><span className="text-zinc-500">Estimated cost</span><span className="font-medium">{fmtUsd(preview.data.estimatedCostUsd)}{!preview.data.isLive && " (mock — free)"}</span></div>
            <div className="flex justify-between"><span className="text-zinc-500">Monthly spend</span><span>{fmtUsd(preview.data.spendUsedUsd)} / {fmtUsd(preview.data.spendCapUsd)}</span></div>
            <div className="flex justify-between"><span className="text-zinc-500">Provider</span><span>{preview.data.providerName}{preview.data.isLive ? "" : " (mock)"}</span></div>
            {!preview.data.withinCap && (
              <p className="rounded-md border border-red-200/30 bg-red-500/10 px-3 py-2 text-red-700">
                Blocked: {preview.data.blockedReason}
              </p>
            )}
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button className={btnSecondary} onClick={() => setPreview(null)} disabled={running}>Cancel</button>
            <button className={btnPrimary} onClick={confirmRun} disabled={running || !preview.data.withinCap}>
              {running ? "Running…" : "Run grid"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Competitors panel
// ---------------------------------------------------------------------------

function CompetitorsPanel({ projectId, canEdit, initialCompetitors, spend }: Pick<Props, "projectId" | "canEdit" | "initialCompetitors" | "spend">) {
  const [competitors, setCompetitors] = useState(initialCompetitors);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ businessName: "", placeId: "", domain: "" });
  const [showRefresh, setShowRefresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<null | {
    status: string;
    refreshed: number;
    skipped: number;
    estimatedCostUsd: number;
    actualCostUsd: number | null;
    alertsEmitted: number;
    note: string | null;
  }>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const enabledCount = competitors.filter((c) => c.enabled).length;
  const refreshEstimate = estimateCompetitorRefreshCost(enabledCount);

  async function refreshCompetitors() {
    const res = await fetch(`/api/local/competitors?projectId=${projectId}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "Failed to load competitors");
    setCompetitors(json.competitors);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      const res = await fetch("/api/local/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          businessName: form.businessName,
          placeId: form.placeId || undefined,
          domain: form.domain || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to add competitor");
      setShowAdd(false);
      setForm({ businessName: "", placeId: "", domain: "" });
      await refreshCompetitors();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add competitor");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(c: CompetitorRow) {
    if (!await confirmAction(`Remove competitor "${c.businessName}" and its snapshots?`)) return;
    setDeleting(c.id);
    setError(null);
    try {
      const res = await fetch(`/api/local/competitors/${c.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to remove competitor");
      await refreshCompetitors();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove competitor");
    } finally {
      setDeleting(null);
    }
  }

  async function handleToggle(c: CompetitorRow) {
    setToggling(c.id);
    setError(null);
    try {
      const res = await fetch(`/api/local/competitors/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !c.enabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to update competitor");
      await refreshCompetitors();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update competitor");
    } finally {
      setToggling(null);
    }
  }

  async function confirmRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/local/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, action: "refresh" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Refresh failed");
      setRefreshResult(json.result);
      await refreshCompetitors();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ErrorBanner message={error} />
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Google Business Profile and review intelligence for nearby competitors — no Google approval needed.
          Snapshots refresh weekly automatically.
        </p>
        {canEdit && (
          <div className="flex gap-2">
            <button className={btnSecondary} onClick={() => setShowRefresh(true)} disabled={enabledCount === 0}>
              Refresh snapshots
            </button>
            <button className={btnSecondary} onClick={() => setShowAdd((s) => !s)}>
              {showAdd ? "Cancel" : "+ Add competitor"}
            </button>
          </div>
        )}
      </div>

      {showAdd && canEdit && (
        <form onSubmit={handleAdd} className={`${cardCls} grid grid-cols-1 gap-3 md:grid-cols-3`}>
          <input className={inputCls} placeholder="Business name" value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} required maxLength={200} />
          <input className={inputCls} placeholder="Google Place ID (optional)" value={form.placeId} onChange={(e) => setForm({ ...form, placeId: e.target.value })} maxLength={200} />
          <input className={inputCls} placeholder="Domain (optional)" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} maxLength={200} />
          <div className="md:col-span-3 flex justify-end">
            <button type="submit" className={btnPrimary} disabled={adding}>
              {adding ? "Adding…" : "Add competitor"}
            </button>
          </div>
        </form>
      )}

      {competitors.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
          No local competitors tracked yet. Add one to start snapshotting its rating and review velocity.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-xs font-medium uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2">Competitor</th>
                <th className="px-3 py-2">Rating</th>
                <th className="px-3 py-2">Reviews</th>
                <th className="px-3 py-2">Δ rating</th>
                <th className="px-3 py-2">Δ reviews</th>
                <th className="px-3 py-2">Snapshot</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {competitors.map((c) => {
                const latest = c.snapshots[0];
                const prev = c.snapshots[1];
                const ratingDelta = latest && prev && latest.rating != null && prev.rating != null ? latest.rating - prev.rating : null;
                const reviewDelta = latest && prev && latest.reviewCount != null && prev.reviewCount != null ? latest.reviewCount - prev.reviewCount : null;
                return (
                  <tr key={c.id} className={`border-b border-stone-100 last:border-0 hover:bg-violet-50/40 ${c.enabled ? "" : "opacity-60"}`}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-zinc-900">{c.businessName}</div>
                      <div className="text-xs text-zinc-500">
                        {c.domain ?? "no domain"}{c.placeId ? ` · ${c.placeId}` : ""}
                        {latest && latest.categories.length > 0 ? ` · ${latest.categories.join(", ")}` : ""}
                      </div>
                      {latest?.address && <div className="text-xs text-zinc-500">{latest.address}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className="inline-flex items-center gap-0.5 font-medium text-zinc-900">
                        {latest?.rating != null ? (<>{latest.rating.toFixed(1)}<Star size={13} className="text-amber-500" fill="currentColor" /></>) : "—"}
                      </span>
                      {latest?.mock && <span className="ml-1 text-xs text-zinc-500">(mock)</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-800">
                      {latest?.reviewCount != null ? latest.reviewCount : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {ratingDelta != null ? (
                        <span className={`inline-flex items-center gap-0.5 ${ratingDelta >= 0 ? "text-green-700" : "text-red-700"}`}>
                          {ratingDelta >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                          {ratingDelta >= 0 ? "+" : ""}{ratingDelta.toFixed(1)}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {reviewDelta != null ? (
                        <span className={reviewDelta >= 0 ? "text-zinc-500" : "text-red-700"}>
                          {reviewDelta >= 0 ? "+" : ""}{reviewDelta}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-500">
                      {c.lastSnapshotAt ? fmtDate(c.lastSnapshotAt) : "no snapshot yet"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${c.enabled ? "border-violet-200 bg-violet-50 text-violet-700" : "border-stone-200 bg-stone-50 text-stone-500"}`}>
                        {c.enabled ? "Active" : "Paused"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {canEdit && (
                        <div className="flex justify-end gap-1">
                          <button
                            className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-400 disabled:opacity-50"
                            onClick={() => handleToggle(c)}
                            disabled={toggling === c.id}
                            title={c.enabled ? "Pause snapshots" : "Resume snapshots"}
                          >
                            {c.enabled ? "Pause" : "Resume"}
                          </button>
                          <button
                            className="rounded-md border border-red-200/40 px-2 py-1 text-xs text-red-700 hover:border-red-300 disabled:opacity-50"
                            onClick={() => handleDelete(c)}
                            disabled={deleting === c.id}
                          >
                            {deleting === c.id ? "…" : "Remove"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showRefresh && (
        <Modal onClose={() => !refreshing && !refreshResult && setShowRefresh(false)}>
          <h3 className="text-lg font-semibold">Refresh competitor snapshots?</h3>
          {refreshResult ? (
            <div className="mt-4 flex flex-col gap-2 text-sm">
              <div className="flex justify-between"><span className="text-zinc-500">Status</span><span className={refreshResult.status === "completed" ? "text-green-700" : "text-amber-700"}>{refreshResult.status}</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Refreshed</span><span>{refreshResult.refreshed} (skipped {refreshResult.skipped})</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Alerts emitted</span><span>{refreshResult.alertsEmitted}</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Actual cost</span><span>{refreshResult.actualCostUsd != null ? fmtUsd(refreshResult.actualCostUsd) : "—"}</span></div>
              {refreshResult.note && <p className="text-zinc-500">{refreshResult.note}</p>}
              <div className="mt-4 flex justify-end">
                <button className={btnPrimary} onClick={() => { setShowRefresh(false); setRefreshResult(null); }}>Done</button>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-col gap-2 text-sm">
                <div className="flex justify-between"><span className="text-zinc-500">Competitors</span><span>{enabledCount} enabled</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Estimated cost</span><span className="font-medium">{fmtUsd(refreshEstimate)} (mock — free)</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Monthly spend</span><span>{fmtUsd(spend.usedUsd)} / {fmtUsd(spend.capUsd)}</span></div>
                <p className="text-xs text-zinc-500">Rating drops and review surges fire alerts through the alert hub.</p>
              </div>
              <div className="mt-6 flex justify-end gap-2">
                <button className={btnSecondary} onClick={() => setShowRefresh(false)} disabled={refreshing}>Cancel</button>
                <button className={btnPrimary} onClick={confirmRefresh} disabled={refreshing}>
                  {refreshing ? "Refreshing…" : "Refresh"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reviews panel
// ---------------------------------------------------------------------------

const SENTIMENT_STYLE: Record<string, string> = {
  pos: "bg-green-500/15 text-green-700 border-green-500/30",
  neu: "bg-zinc-500/15 text-zinc-500 border-zinc-200",
  neg: "bg-red-500/15 text-red-700 border-red-200/30",
};

function ReviewsPanel({ projectId, canEdit, reviewSummary, sentimentCounts, spend }: Pick<Props, "projectId" | "canEdit" | "reviewSummary" | "sentimentCounts" | "spend">) {
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [counts, setCounts] = useState(sentimentCounts);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ rating: "", sentiment: "", responded: "", q: "" });
  const [showIngest, setShowIngest] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestResult, setIngestResult] = useState<null | {
    status: string;
    fetched: number;
    newReviews: number;
    estimatedCostUsd: number;
    actualCostUsd: number | null;
    alertsEmitted: number;
    note: string | null;
  }>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  const ingestEstimate = estimateReviewsIngestCost();

  async function loadReviews() {
    setError(null);
    try {
      const sp = new URLSearchParams({ projectId });
      if (filters.rating) sp.set("rating", filters.rating);
      if (filters.sentiment) sp.set("sentiment", filters.sentiment);
      if (filters.responded) sp.set("responded", filters.responded);
      if (filters.q.trim()) sp.set("q", filters.q.trim());
      const res = await fetch(`/api/local/reviews?${sp.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load reviews");
      setReviews(json.reviews as ReviewRow[]);
      setCounts(Object.fromEntries((json.counts as Array<{ sentiment: string; _count: number }>).map((c) => [c.sentiment, c._count])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reviews");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadReviews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.rating, filters.sentiment, filters.responded]);

  async function handleMarkResponded(review: ReviewRow) {
    setUpdating(review.id);
    setError(null);
    try {
      const res = await fetch("/api/local/reviews", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId: review.id, responded: !review.responded }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to update review");
      setReviews((rs) => rs.map((r) => (r.id === review.id ? { ...r, responded: !r.responded } : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update review");
    } finally {
      setUpdating(null);
    }
  }

  async function confirmIngest() {
    setIngesting(true);
    setError(null);
    try {
      const res = await fetch("/api/local/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, action: "ingest" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Ingest failed");
      setIngestResult(json.result);
      await loadReviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingest failed");
    } finally {
      setIngesting(false);
    }
  }

  const pos = counts.pos ?? 0;
  const neu = counts.neu ?? 0;
  const neg = counts.neg ?? 0;
  const total = pos + neu + neg;

  return (
    <div className="flex flex-col gap-4">
      <ErrorBanner message={error} />
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Review monitoring with sentiment analysis. New and negative reviews fire alerts through the alert hub.
        </p>
        {canEdit && (
          <button className={btnSecondary} onClick={() => setShowIngest(true)}>
            Ingest reviews
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className={`${cardCls}`}>
          <p className="text-xs uppercase tracking-widest text-zinc-500">Avg rating</p>
          <p className="mt-1 inline-flex items-center gap-1 text-2xl font-semibold">{reviewSummary?.avgRating != null ? (<>{reviewSummary.avgRating.toFixed(1)}<Star size={18} className="text-amber-500" fill="currentColor" /></>) : "—"}</p>
          <p className="mt-0.5 text-xs text-zinc-500">{reviewSummary?.count ?? 0} in latest weekly summary</p>
        </div>
        <div className={cardCls}>
          <p className="text-xs uppercase tracking-widest text-zinc-500">Positive</p>
          <p className="mt-1 text-2xl font-semibold text-green-700">{pos}</p>
          <p className="mt-0.5 text-xs text-zinc-500">{total > 0 ? `${Math.round((pos / total) * 100)}%` : "—"} of all reviews</p>
        </div>
        <div className={cardCls}>
          <p className="text-xs uppercase tracking-widest text-zinc-500">Neutral</p>
          <p className="mt-1 text-2xl font-semibold text-zinc-500">{neu}</p>
          <p className="mt-0.5 text-xs text-zinc-500">{total > 0 ? `${Math.round((neu / total) * 100)}%` : "—"} of all reviews</p>
        </div>
        <div className={cardCls}>
          <p className="text-xs uppercase tracking-widest text-zinc-500">Negative</p>
          <p className="mt-1 text-2xl font-semibold text-red-700">{neg}</p>
          <p className="mt-0.5 text-xs text-zinc-500">{total > 0 ? `${Math.round((neg / total) * 100)}%` : "—"} of all reviews</p>
        </div>
      </div>

      {reviewSummary && reviewSummary.topThemes.length > 0 && (
        <div className={cardCls}>
          <p className="mb-2 text-xs uppercase tracking-widest text-zinc-500">Top themes</p>
          <div className="flex flex-wrap gap-2">
            {reviewSummary.topThemes.map((t) => (
              <span key={t.theme} className="rounded-full border border-zinc-200 bg-zinc-100 px-3 py-1 text-xs text-zinc-500">
                {t.theme} <span className="text-zinc-500">×{t.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className={`${cardCls} flex flex-col gap-3`}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <select className={inputCls} value={filters.rating} onChange={(e) => setFilters({ ...filters, rating: e.target.value })} title="Filter by rating">
            <option value="">All ratings</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>{n}★</option>
            ))}
          </select>
          <select className={inputCls} value={filters.sentiment} onChange={(e) => setFilters({ ...filters, sentiment: e.target.value })} title="Filter by sentiment">
            <option value="">All sentiment</option>
            <option value="pos">Positive</option>
            <option value="neu">Neutral</option>
            <option value="neg">Negative</option>
          </select>
          <select className={inputCls} value={filters.responded} onChange={(e) => setFilters({ ...filters, responded: e.target.value })} title="Filter by response status">
            <option value="">Responded + unresponded</option>
            <option value="1">Responded</option>
            <option value="0">Unresponded</option>
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              loadReviews();
            }}
            className="flex gap-2"
          >
            <input className={inputCls} placeholder="Search text or author…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </form>
        </div>

        {loading ? (
          <p className="py-6 text-center text-sm text-zinc-500">Loading reviews…</p>
        ) : reviews.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            No reviews match. Ingest reviews to pull your latest Google reviews.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs uppercase tracking-widest text-zinc-500">
                  <th className="py-2 pr-3">Author</th>
                  <th className="py-2 pr-3">Rating</th>
                  <th className="py-2 pr-3">Sentiment</th>
                  <th className="py-2 pr-3">Review</th>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-200/60 align-top">
                    <td className="py-2 pr-3 text-zinc-800">{r.author ?? "—"}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-zinc-800"><span className="inline-flex items-center gap-0.5">{r.rating != null ? (<>{r.rating}<Star size={12} className="text-amber-500" fill="currentColor" /></>) : "—"}</span></td>
                    <td className="py-2 pr-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${SENTIMENT_STYLE[r.sentiment] ?? SENTIMENT_STYLE.neu}`}>
                        {r.sentiment}
                      </span>
                    </td>
                    <td className="max-w-md py-2 pr-3 text-zinc-500">
                      {r.text ?? <span className="text-zinc-500">no text</span>}
                      {r.mock && <span className="ml-2 text-xs text-zinc-500">(mock)</span>}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-zinc-500">{r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : "—"}</td>
                    <td className="py-2">
                      {canEdit ? (
                        <button
                          className={`rounded-md border px-2 py-1 text-xs disabled:opacity-50 ${
                            r.responded
                              ? "border-green-500/40 text-green-700 hover:border-green-300"
                              : "border-zinc-200 text-zinc-500 hover:border-zinc-400"
                          }`}
                          onClick={() => handleMarkResponded(r)}
                          disabled={updating === r.id}
                        >
                          {updating === r.id ? "…" : r.responded ? (<span className="inline-flex items-center gap-1">Responded <Check size={12} /></span>) : "Mark responded"}
                        </button>
                      ) : (
                        <span className="text-xs text-zinc-500">{r.responded ? "Responded" : "Unresponded"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showIngest && (
        <Modal onClose={() => !ingesting && !ingestResult && setShowIngest(false)}>
          <h3 className="text-lg font-semibold">Ingest latest reviews?</h3>
          {ingestResult ? (
            <div className="mt-4 flex flex-col gap-2 text-sm">
              <div className="flex justify-between"><span className="text-zinc-500">Status</span><span className={ingestResult.status === "completed" ? "text-green-700" : "text-amber-700"}>{ingestResult.status}</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Fetched</span><span>{ingestResult.fetched} ({ingestResult.newReviews} new)</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Alerts emitted</span><span>{ingestResult.alertsEmitted}</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Actual cost</span><span>{ingestResult.actualCostUsd != null ? fmtUsd(ingestResult.actualCostUsd) : "—"}</span></div>
              {ingestResult.note && <p className="text-zinc-500">{ingestResult.note}</p>}
              <div className="mt-4 flex justify-end">
                <button className={btnPrimary} onClick={() => { setShowIngest(false); setIngestResult(null); }}>Done</button>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-col gap-2 text-sm">
                <div className="flex justify-between"><span className="text-zinc-500">Estimated cost</span><span className="font-medium">{fmtUsd(ingestEstimate)} (mock — free)</span></div>
                <div className="flex justify-between"><span className="text-zinc-500">Monthly spend</span><span>{fmtUsd(spend.usedUsd)} / {fmtUsd(spend.capUsd)}</span></div>
                <p className="text-xs text-zinc-500">Pulls your latest Google reviews, classifies sentiment, and alerts on new or negative reviews.</p>
              </div>
              <div className="mt-6 flex justify-end gap-2">
                <button className={btnSecondary} onClick={() => setShowIngest(false)} disabled={ingesting}>Cancel</button>
                <button className={btnPrimary} onClick={confirmIngest} disabled={ingesting}>
                  {ingesting ? "Ingesting…" : "Ingest"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab shell
// ---------------------------------------------------------------------------

const TABS = [
  { key: "grids", label: "Geo-grids", icon: MapPinned },
  { key: "competitors", label: "Competitors", icon: Crosshair },
  { key: "reviews", label: "Reviews", icon: Star },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function LocalSeoTabs(props: Props) {
  const [tab, setTab] = useState<TabKey>("grids");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 border-b border-zinc-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors ${
              tab === t.key
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            <t.icon size={15} />
            {t.label}
          </button>
        ))}
      </div>
      {tab === "grids" && (
        <GridsPanel
          projectId={props.projectId}
          canEdit={props.canEdit}
          initialGrids={props.initialGrids}
          spend={props.spend}
        />
      )}
      {tab === "competitors" && (
        <CompetitorsPanel
          projectId={props.projectId}
          canEdit={props.canEdit}
          initialCompetitors={props.initialCompetitors}
          spend={props.spend}
        />
      )}
      {tab === "reviews" && (
        <ReviewsPanel
          projectId={props.projectId}
          canEdit={props.canEdit}
          reviewSummary={props.reviewSummary}
          sentimentCounts={props.sentimentCounts}
          spend={props.spend}
        />
      )}
    </div>
  );
}
