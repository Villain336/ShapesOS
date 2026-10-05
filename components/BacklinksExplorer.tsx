// Marketr — backlink explorer (milestone 15, client island).
// Summary cards, filtered link table, lost-link view, and a refresh flow
// that ALWAYS shows the cost preview modal before any paid pull runs.

"use client";

import { useMemo, useState } from "react";
import { closeOnEscape } from "@/lib/ui/keyboard";

interface BacklinkItem {
  id: string;
  sourceDomain: string;
  sourceUrl: string;
  targetUrl: string;
  anchorText: string | null;
  dofollow: boolean;
  sourceRank: number | null;
  spamScore: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  status: "active" | "lost";
}

interface SummaryItem {
  id: string;
  date: string;
  total: number;
  referringDomains: number;
  dofollowRatio: number | null;
  snapshot: Record<string, unknown>;
  mock: boolean;
}

interface PullPreview {
  providerName: string;
  isLive: boolean;
  target: string;
  rowsRequested: number;
  estimatedCostUsd: number;
  summaryCostUsd: number;
  spendUsedUsd: number;
  spendCapUsd: number;
  withinCap: boolean;
  blockedReason: string | null;
}

interface PullResult {
  status: string;
  rowsReturned: number;
  newLinks: number;
  lostLinks: number;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  lostMarked: boolean;
  alertsEmitted: number;
  note: string | null;
}

export default function BacklinksExplorer({
  projectId,
  domain,
  canManageSpend,
  canToggleBacklinks,
  backlinksEnabled,
  initialLinks,
  initialSummaries,
  counts,
  spend,
}: {
  projectId: string;
  domain: string;
  canManageSpend: boolean;
  canToggleBacklinks: boolean;
  backlinksEnabled: boolean;
  initialLinks: BacklinkItem[];
  initialSummaries: SummaryItem[];
  counts: Record<string, number>;
  spend: { usedUsd: number; capUsd: number; custom: boolean; defaultCapUsd: number };
}) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [dofollowOnly, setDofollowOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [showRefresh, setShowRefresh] = useState(false);
  const [limit, setLimit] = useState(500);
  const [preview, setPreview] = useState<PullPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<PullResult | null>(null);
  const [spendState, setSpendState] = useState(spend);
  const [capInput, setCapInput] = useState(String(spend.capUsd));
  const [capSaving, setCapSaving] = useState(false);
  const [enabled, setEnabled] = useState(backlinksEnabled);
  const [toggling, setToggling] = useState(false);

  async function toggleEnabled() {
    if (!canToggleBacklinks || toggling) return;
    setToggling(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backlinksEnabled: !enabled }),
      });
      const json = await res.json();
      if (res.ok) setEnabled(Boolean(json.backlinksEnabled));
    } finally {
      setToggling(false);
    }
  }

  const latest = initialSummaries[0] ?? null;

  const visible = useMemo(
    () =>
      initialLinks.filter((l) => {
        if (statusFilter !== "all" && l.status !== statusFilter) return false;
        if (dofollowOnly && !l.dofollow) return false;
        if (query) {
          const q = query.toLowerCase();
          const hay = `${l.anchorText ?? ""} ${l.sourceDomain} ${l.sourceUrl}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [initialLinks, statusFilter, dofollowOnly, query],
  );

  async function openRefresh() {
    setShowRefresh(true);
    setPreview(null);
    setPullResult(null);
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/backlinks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, action: "preview", limit, target: domain }),
      });
      const json = await res.json();
      if (res.ok) setPreview(json.preview);
      else setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmPull() {
    if (!preview || !preview.withinCap) return;
    setPulling(true);
    try {
      const res = await fetch("/api/backlinks/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, limit, target: domain }),
      });
      const json = await res.json();
      if (res.ok) {
        setPullResult(json.result);
        const s = await fetch("/api/workspace/spend-cap").then((r) => r.json());
        if (s.capUsd != null) setSpendState({ ...spendState, usedUsd: s.usedUsd, capUsd: s.capUsd });
      }
    } finally {
      setPulling(false);
    }
  }

  async function saveCap() {
    const v = capInput.trim() === "" ? null : Number(capInput);
    if (v !== null && (!Number.isFinite(v) || v < 0)) return;
    setCapSaving(true);
    try {
      const res = await fetch("/api/workspace/spend-cap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capUsd: v }),
      });
      const json = await res.json();
      if (res.ok) {
        setSpendState({ ...spendState, capUsd: json.capUsd, custom: json.custom });
        setCapInput(String(json.capUsd));
      }
    } finally {
      setCapSaving(false);
    }
  }

  const spendPct = Math.min(100, (spendState.usedUsd / Math.max(spendState.capUsd, 0.01)) * 100);

  return (
    <div className="flex flex-col gap-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Total backlinks" value={latest ? latest.total.toLocaleString() : "—"} sub={latest?.mock ? "mock data" : latest ? `as of ${latest.date.slice(0, 10)}` : "no pull yet"} />
        <Card label="Referring domains" value={latest ? latest.referringDomains.toLocaleString() : "—"} sub="distinct domains" />
        <Card label="Dofollow ratio" value={latest?.dofollowRatio != null ? `${Math.round(latest.dofollowRatio * 100)}%` : "—"} sub="of indexed links" />
        <Card label="Lost links" value={String(counts.lost ?? 0)} sub={`${counts.active ?? 0} active`} accent />
      </div>

      {/* Spend bar */}
      <div className="rounded-lg bg-paper shadow-hairline p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-muted">
            <span className="font-medium">Monthly backlinks spend:</span>{" "}
            <span className={spendPct >= 90 ? "text-failed-text" : "text-ink"}>
              ${spendState.usedUsd.toFixed(4)} / ${spendState.capUsd.toFixed(2)}
            </span>
            {!spendState.custom && <span className="ml-2 text-xs text-muted">(default guardrail)</span>}
          </div>
          <div className="flex items-center gap-3">
            {canToggleBacklinks ? (
              <button
                onClick={toggleEnabled}
                disabled={toggling}
                title="Weekly backlink refresh for this project"
                role="switch"
                aria-checked={enabled}
                className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${enabled ? "bg-ink" : "bg-disabled-fg"}`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-paper transition-[left] duration-150 ${enabled ? "left-[18px]" : "left-0.5"}`}
                />
              </button>
            ) : null}
            <span className="text-xs text-muted" title="Weekly backlink refresh for this project">
              Auto-refresh {enabled ? "on" : "off"}
            </span>
            <button
              onClick={openRefresh}
              className="rounded-full bg-ink px-4 py-1.5 text-sm font-semibold text-white hover:bg-night-hover aos-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Refresh backlinks…
            </button>
          </div>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas">
          <div
            className={`h-full rounded-full ${spendPct >= 90 ? "bg-failed" : "bg-ink"}`}
            style={{ width: `${spendPct}%` }}
          />
        </div>
        {canManageSpend && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <label className="text-muted">Monthly cap (USD):</label>
            <input
              value={capInput}
              onChange={(e) => setCapInput(e.target.value)}
              inputMode="decimal"
              className="w-24 rounded-md border-[1.5px] border-control bg-paper px-2 py-1 text-ink"
            />
            <button
              onClick={saveCap}
              disabled={capSaving}
              className="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-ink shadow-control hover:shadow-outline disabled:opacity-50"
            >
              {capSaving ? "Saving…" : "Save"}
            </button>
            <span className="text-xs text-muted">Empty = revert to default (${spendState.defaultCapUsd}).</span>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border-[1.5px] border-control bg-paper px-3 py-1.5 text-sm text-ink"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="lost">Lost</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input type="checkbox" checked={dofollowOnly} onChange={(e) => setDofollowOnly(e.target.checked)} />
          Dofollow only
        </label>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search anchor, domain, URL…"
          className="min-w-52 flex-1 rounded-md border-[1.5px] border-control bg-paper px-3 py-1.5 text-sm text-ink placeholder:text-subtle"
        />
        <span className="text-xs text-muted">{visible.length} shown</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-line bg-paper">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-canvas text-xs text-muted">
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Anchor</th>
              <th className="px-3 py-2">Follow</th>
              <th className="px-3 py-2">Rank</th>
              <th className="px-3 py-2">Spam</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                <td className="max-w-64 px-3 py-2">
                  <div className="truncate font-medium text-ink" title={l.sourceUrl}>{l.sourceDomain}</div>
                  <div className="truncate text-xs text-muted" title={l.sourceUrl}>→ {l.targetUrl.replace(/^https?:\/\//, "").slice(0, 60)}</div>
                </td>
                <td className="max-w-48 truncate px-3 py-2 text-muted">{l.anchorText ?? <span className="text-muted">—</span>}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${l.dofollow ? "bg-paper text-ink shadow-control" : "bg-canvas text-muted"}`}>
                    {l.dofollow ? "follow" : "nofollow"}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted">{l.sourceRank ?? "—"}</td>
                <td className="px-3 py-2 text-muted">{l.spamScore ?? "—"}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${l.status === "lost" ? "bg-ink text-white" : "bg-canvas text-muted"}`}>
                    {l.status}
                  </span>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted">
                  {initialLinks.length === 0
                    ? "No backlink data yet — run a refresh to pull the link profile."
                    : "No links match these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Refresh modal */}
      {showRefresh && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation" onClick={() => !pulling && setShowRefresh(false)} onKeyDown={closeOnEscape(() => !pulling && setShowRefresh(false))}>
          <div className="w-full max-w-md rounded-lg bg-paper shadow-overlay p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-heading tracking-heading stretch-heading text-ink">Refresh backlinks</h2>
            <p className="mt-1 text-sm text-muted">
              Pulls the live link profile for <span className="text-ink">{domain}</span>. This spends
              DataForSEO credits — review the estimate first.
            </p>
            <label className="mt-4 block text-sm text-muted">
              Rows to pull (max 10,000)
              <input
                type="number"
                min={1}
                max={10000}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-1.5 text-ink"
              />
            </label>

            {previewLoading && <p className="mt-4 text-sm text-muted">Estimating cost…</p>}

            {preview && (
              <div className="mt-4 rounded-lg border border-line bg-canvas p-4 text-sm">
                <div className="flex justify-between text-muted">
                  <span>Provider</span>
                  <span className="text-ink">{preview.providerName}{preview.isLive ? "" : " (mock — free)"}</span>
                </div>
                <div className="mt-1 flex justify-between text-muted">
                  <span>Rows requested</span>
                  <span className="text-ink">{preview.rowsRequested.toLocaleString()}</span>
                </div>
                <div className="mt-1 flex justify-between font-medium text-ink">
                  <span>Estimated cost</span>
                  <span>${preview.estimatedCostUsd.toFixed(4)}</span>
                </div>
                <div className="mt-1 flex justify-between text-muted">
                  <span>Budget after pull</span>
                  <span>${(preview.spendUsedUsd + preview.estimatedCostUsd).toFixed(4)} / ${preview.spendCapUsd.toFixed(2)}</span>
                </div>
                {!preview.withinCap && (
                  <p className="mt-2 rounded-md border border-failed bg-failed-tint p-2 text-xs text-failed-text">
                    {preview.blockedReason}
                  </p>
                )}
              </div>
            )}

            {pullResult && (
              <div className="mt-4 rounded-lg border border-line bg-canvas p-4 text-sm text-muted">
                <p className="font-medium text-ink">Pull {pullResult.status}</p>
                <p className="mt-1">
                  {pullResult.rowsReturned.toLocaleString()} rows · {pullResult.newLinks} new ·{" "}
                  {pullResult.lostLinks} lost · ${pullResult.actualCostUsd?.toFixed(4) ?? "—"}
                </p>
                {pullResult.note && <p className="mt-1 text-xs text-muted">{pullResult.note}</p>}
                <p className="mt-1 text-xs text-muted">Reload the page to see updated data.</p>
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowRefresh(false)}
                disabled={pulling}
                className="rounded-full bg-paper px-4 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-50"
              >
                {pullResult ? "Close" : "Cancel"}
              </button>
              {!pullResult && (
                <button
                  onClick={confirmPull}
                  disabled={!preview || !preview.withinCap || pulling}
                  className="rounded-full bg-ink px-4 py-1.5 text-sm font-semibold text-white hover:bg-night-hover disabled:opacity-40 aos-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {pulling ? "Pulling…" : `Confirm pull${preview ? ` — $${preview.estimatedCostUsd.toFixed(4)}` : ""}`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${accent && value !== "0" ? "border-ink bg-paper" : "border-line bg-paper"}`}>
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className="mt-1 text-xl font-heading tracking-heading stretch-heading text-ink">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{sub}</div>
    </div>
  );
}
