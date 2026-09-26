// Marketr — Phase 10 M4: Competitor change fleet UI client.
//
// House pattern per app/dashboard/studio/StudioApp.tsx (AGENTS.md): page
// shell bg-[#FAFAF7] p-4 md:p-6 (in page.tsx), title text-xl bold,
// subtitle text-[13px] text-stone-500, sub-tabs with Lucide icon + label and
// ACTIVE = border-violet-600 text-violet-700, primary buttons
// bg-violet-600 hover:bg-violet-700, data lists as DENSE TABLES with badge
// columns and rows hover:bg-violet-50/40, filter toolbar = dropdowns +
// search + violet button, info notes border-stone-200 bg-stone-50.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  CheckCircle2,
  Eye,
  Globe,
  ListChecks,
  Loader2,
  Newspaper,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Star,
  Trash2,
  XCircle,
} from "lucide-react";
import { googleAlertsGuidance } from "@/lib/intelligence/fleet/google-alerts";

// ── Small atoms (same recipe as StudioApp / RadarClient) ─────────────────────

function Chip({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue";
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}
    >
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

interface Project {
  id: string;
  domain: string | null;
}

interface FleetChange {
  id: string;
  watchId: string;
  projectId: string;
  competitorDomain: string;
  url: string;
  detectedAt: string;
  changeType: string;
  semanticSummary: string | null;
  whyItMatters: string | null;
  recommendedResponse: string | null;
  status: string;
}

interface Watch {
  id: string;
  projectId: string;
  competitorDomain: string;
  sitemapUrl: string | null;
  lastDiffAt: string | null;
  changeCount: number;
}

interface Digest {
  workspaceId: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  competitors: Array<{
    domain: string;
    pagesAdded: number;
    pagesRemoved: number;
    pagesUpdated: number;
    pricingOfferChanges: number;
    topChanges: Array<{ url: string; changeType: string; summary: string | null }>;
  }>;
  totals: {
    pagesAdded: number;
    pagesRemoved: number;
    pagesUpdated: number;
    pricingOfferChanges: number;
    changes: number;
  };
  serpPresence: Array<{
    keyword: string;
    competitorDomain: string;
    position: number;
    backedByPageChange: boolean;
  }>;
  serpAvailable: boolean;
  reviewVelocity: Array<{
    source: string;
    status: string;
    reviewsThisWeek: number;
    avgRating: number | null;
    detail?: string;
  }>;
}

interface ReviewPull {
  result: {
    status: string;
    source: string;
    detail?: string;
  };
  velocity: { reviewsThisWeek: number; avgRating: number | null };
  themes: Array<{ theme: string; mentions: number; example: string }>;
}

const CHANGE_LABELS: Record<string, string> = {
  page_added: "Page added",
  page_removed: "Page removed",
  content_updated: "Content updated",
  metadata_updated: "Metadata updated",
  structure_changed: "Structure changed",
};

function changeTone(t: string): "blue" | "red" | "amber" | "slate" | "violet" {
  if (t === "page_added") return "blue";
  if (t === "page_removed") return "red";
  if (t === "content_updated") return "amber";
  if (t === "structure_changed") return "violet";
  return "slate";
}

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  reviewed: "Reviewed",
  actioned: "Actioned",
  dismissed: "Dismissed",
};

function statusTone(s: string): "amber" | "blue" | "green" | "slate" {
  if (s === "new") return "amber";
  if (s === "reviewed") return "blue";
  if (s === "actioned") return "green";
  return "slate";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "/" : u.pathname;
    const s = `${u.hostname}${path}`;
    return s.length > 56 ? `${s.slice(0, 55)}…` : s;
  } catch {
    return url.length > 56 ? `${url.slice(0, 55)}…` : url;
  }
}

function truncate(s: string | null, n: number): string {
  if (!s) return "—";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ── Changes tab ──────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-3 py-1.5">
      <dt className="text-[12px] font-medium text-stone-500">{label}</dt>
      <dd className="text-[13px] text-stone-800">{value || "—"}</dd>
    </div>
  );
}

function ChangesTab({ projects }: { projects: Project[] }) {
  const [changes, setChanges] = useState<FleetChange[]>([]);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [fWatch, setFWatch] = useState("");
  const [fType, setFType] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (projectId) qs.set("projectId", projectId);
      if (fWatch) qs.set("watchId", fWatch);
      if (fType) qs.set("changeType", fType);
      if (fStatus) qs.set("status", fStatus);
      if (q.trim()) qs.set("q", q.trim());
      qs.set("take", "100");
      const r = await fetch(`/api/intelligence/fleet/changes?${qs.toString()}`);
      const d = await r.json();
      setChanges(d.changes ?? []);
    } catch {
      // keep previous list on transient failure
    } finally {
      setLoading(false);
    }
  }, [projectId, fWatch, fType, fStatus, q]);

  const loadWatches = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (projectId) qs.set("projectId", projectId);
      const r = await fetch(`/api/intelligence/fleet/watches?${qs.toString()}`);
      const d = await r.json();
      setWatches(d.watches ?? []);
    } catch {
      // non-fatal
    }
  }, [projectId]);

  useEffect(() => {
    const t = setTimeout(loadWatches, 0);
    return () => clearTimeout(t);
  }, [loadWatches]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const runFleet = useCallback(async () => {
    setRunning(true);
    try {
      await fetch("/api/cron/fleet", { method: "POST" });
    } catch {
      // non-fatal
    } finally {
      setRunning(false);
      load();
    }
  }, [load]);

  const setStatus = useCallback(
    async (id: string, status: string) => {
      setActingId(id);
      try {
        const r = await fetch("/api/intelligence/fleet/changes", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, status }),
        });
        if (r.ok) {
          setChanges((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
        }
      } catch {
        // non-fatal
      } finally {
        setActingId(null);
      }
    },
    [],
  );

  const expanded = useMemo(
    () => changes.find((c) => c.id === expandedId) ?? null,
    [changes, expandedId],
  );

  return (
    <div>
      <div className="mb-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-[12.5px] text-stone-600">
        <span className="font-medium text-stone-800">Propose-only. </span>
        The fleet reports — semantic summaries and recommended responses are
        proposals. Anything that acts goes through the Phase 9 approval
        executor; nothing here runs automatically.
      </div>

      {/* Filter toolbar: dropdowns + search + violet button */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.domain ?? p.id}
            </option>
          ))}
        </select>
        <select value={fWatch} onChange={(e) => setFWatch(e.target.value)} className={inputCls}>
          <option value="">All competitors</option>
          {watches.map((w) => (
            <option key={w.id} value={w.id}>
              {w.competitorDomain}
            </option>
          ))}
        </select>
        <select value={fType} onChange={(e) => setFType(e.target.value)} className={inputCls}>
          <option value="">All change types</option>
          {Object.entries(CHANGE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={inputCls}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search URLs…"
            className={`${inputCls} pl-8`}
          />
        </div>
        <button onClick={runFleet} disabled={running} className={btnPrimary}>
          {running ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
          Run fleet now
        </button>
      </div>

      {/* Dense change table */}
      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2 font-medium">Detected</th>
              <th className="px-3 py-2 font-medium">Competitor</th>
              <th className="px-3 py-2 font-medium">Change</th>
              <th className="px-3 py-2 font-medium">Page</th>
              <th className="px-3 py-2 font-medium">Semantic summary</th>
              <th className="px-3 py-2 font-medium">Recommended response</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <tr
                key={c.id}
                onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                className={`cursor-pointer border-b border-stone-100 last:border-0 hover:bg-violet-50/40 ${
                  expandedId === c.id ? "bg-violet-50/60" : ""
                }`}
              >
                <td className="whitespace-nowrap px-3 py-2 text-stone-500">{fmtDate(c.detectedAt)}</td>
                <td className="whitespace-nowrap px-3 py-2 font-medium text-stone-900">
                  {c.competitorDomain}
                </td>
                <td className="px-3 py-2">
                  <Chip tone={changeTone(c.changeType)}>{CHANGE_LABELS[c.changeType] ?? c.changeType}</Chip>
                </td>
                <td className="max-w-[220px] truncate px-3 py-2 text-stone-600" title={c.url}>
                  {shortUrl(c.url)}
                </td>
                <td className="max-w-[280px] truncate px-3 py-2 text-stone-700" title={c.semanticSummary ?? ""}>
                  {truncate(c.semanticSummary, 90)}
                </td>
                <td className="max-w-[280px] truncate px-3 py-2 text-stone-700" title={c.recommendedResponse ?? ""}>
                  {truncate(c.recommendedResponse, 90)}
                </td>
                <td className="px-3 py-2">
                  <Chip tone={statusTone(c.status)}>{STATUS_LABELS[c.status] ?? c.status}</Chip>
                </td>
              </tr>
            ))}
            {changes.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-[13px] text-stone-400">
                  No changes yet — add competitors in the Watchlist tab, then run the fleet.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-[13px] text-stone-400">
                  <Loader2 size={16} className="mx-auto animate-spin" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Expanded change detail */}
      {expanded && (
        <div className="mt-3 rounded-lg border border-stone-200 bg-white p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-stone-900">{expanded.competitorDomain}</span>
            <Chip tone={changeTone(expanded.changeType)}>
              {CHANGE_LABELS[expanded.changeType] ?? expanded.changeType}
            </Chip>
            <Chip tone={statusTone(expanded.status)}>{STATUS_LABELS[expanded.status] ?? expanded.status}</Chip>
            <span className="text-[12px] text-stone-500">{fmtDate(expanded.detectedAt)}</span>
          </div>
          <dl className="divide-y divide-stone-100">
            <DetailRow label="Page" value={expanded.url} />
            <DetailRow label="Semantic summary" value={expanded.semanticSummary} />
            <DetailRow label="Why it matters" value={expanded.whyItMatters} />
            <DetailRow label="Recommended response" value={expanded.recommendedResponse} />
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => setStatus(expanded.id, "reviewed")} disabled={actingId === expanded.id} className={btnGhost}>
              <Eye size={14} /> Mark reviewed
            </button>
            <button onClick={() => setStatus(expanded.id, "actioned")} disabled={actingId === expanded.id} className={btnGhost}>
              <CheckCircle2 size={14} /> Mark actioned
            </button>
            <button onClick={() => setStatus(expanded.id, "dismissed")} disabled={actingId === expanded.id} className={btnGhost}>
              <XCircle size={14} /> Dismiss
            </button>
            <span className="text-[12px] text-stone-400">
              “Actioned” means you handled it outside Marketr (e.g. via the Phase 9 approval
              executor) — the fleet never acted on its own.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Watchlist tab ────────────────────────────────────────────────────────────

function WatchlistTab({ projects }: { projects: Project[] }) {
  const [watches, setWatches] = useState<Watch[]>([]);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [domain, setDomain] = useState("");
  const [sitemapUrl, setSitemapUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (projectId) qs.set("projectId", projectId);
      const r = await fetch(`/api/intelligence/fleet/watches?${qs.toString()}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "failed to load watchlist");
      setWatches(d.watches ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load watchlist");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const addWatch = useCallback(async () => {
    if (!domain.trim() || !projectId) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/intelligence/fleet/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          competitorDomain: domain.trim(),
          sitemapUrl: sitemapUrl.trim() || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "failed to add watch");
      setDomain("");
      setSitemapUrl("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to add watch");
    } finally {
      setSaving(false);
    }
  }, [domain, sitemapUrl, projectId, load]);

  const deleteWatch = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/intelligence/fleet/watches?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        setWatches((prev) => prev.filter((w) => w.id !== id));
      } catch {
        // non-fatal
      }
    },
    [],
  );

  return (
    <div>
      <div className="mb-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-[12.5px] text-stone-600">
        <span className="font-medium text-stone-800">Polite by design. </span>
        The fleet fetches sitemaps and tracked pages with ≥2s between hits per
        domain, a 15s timeout, an identifiable user agent, and a real
        robots.txt check before every page fetch — crawl-delay honored when
        larger. Adding a watch only registers the competitor; the weekly cron
        does the fetching.
      </div>

      {/* Add-watch toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.domain ?? p.id}
            </option>
          ))}
        </select>
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="competitor.com"
          className={`${inputCls} w-52`}
        />
        <input
          value={sitemapUrl}
          onChange={(e) => setSitemapUrl(e.target.value)}
          placeholder="sitemap.xml URL (optional — auto-detected)"
          className={`${inputCls} w-72`}
        />
        <button onClick={addWatch} disabled={saving || !domain.trim()} className={btnPrimary}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Add competitor
        </button>
      </div>
      {error && <p className="mb-3 text-[13px] text-red-600">{error}</p>}

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2 font-medium">Competitor</th>
              <th className="px-3 py-2 font-medium">Sitemap</th>
              <th className="px-3 py-2 font-medium">Last diff</th>
              <th className="px-3 py-2 font-medium">Changes</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {watches.map((w) => (
              <tr key={w.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                <td className="px-3 py-2 font-medium text-stone-900">
                  <span className="inline-flex items-center gap-1.5">
                    <Globe size={13} className="text-stone-400" />
                    {w.competitorDomain}
                  </span>
                </td>
                <td className="max-w-[320px] truncate px-3 py-2 text-stone-600" title={w.sitemapUrl ?? ""}>
                  {w.sitemapUrl ? shortUrl(w.sitemapUrl) : <span className="text-stone-400">auto-detect</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-stone-500">{fmtDate(w.lastDiffAt)}</td>
                <td className="px-3 py-2">
                  {w.changeCount > 0 ? <Chip tone="violet">{w.changeCount}</Chip> : <span className="text-stone-400">—</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => deleteWatch(w.id)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-stone-500 hover:bg-red-50 hover:text-red-600"
                    title="Remove watch"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {watches.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[13px] text-stone-400">
                  No competitors watched yet — add one above.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[13px] text-stone-400">
                  <Loader2 size={16} className="mx-auto animate-spin" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Digest tab ───────────────────────────────────────────────────────────────

function DigestTab({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [digest, setDigest] = useState<Digest | null>(null);
  const [loading, setLoading] = useState(false);
  const [alertDomainPick, setAlertDomainPick] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (projectId) qs.set("projectId", projectId);
      const r = await fetch(`/api/intelligence/fleet/digest?${qs.toString()}`);
      const d = await r.json();
      if (r.ok) setDigest(d.digest ?? null);
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  // Derived, not synced: the alerts-domain select defaults to the first
  // competitor in the digest; the user's explicit pick wins once set.
  const alertDomain =
    alertDomainPick || digest?.competitors[0]?.domain || "competitor.com";

  const t = digest?.totals;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.domain ?? p.id}
            </option>
          ))}
        </select>
        <button onClick={load} disabled={loading} className={btnPrimary}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Rebuild digest
        </button>
        {digest && (
          <span className="text-[12px] text-stone-400">
            Week {fmtDate(digest.weekStart)} – {fmtDate(digest.weekEnd)} · generated{" "}
            {fmtDate(digest.generatedAt)}
          </span>
        )}
      </div>

      {!digest && !loading && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-8 text-center text-[13px] text-stone-400">
          No digest yet — the weekly cron builds it automatically.
        </div>
      )}

      {digest && t && (
        <div className="space-y-4">
          {/* Totals */}
          <div className="flex flex-wrap gap-2">
            <Chip tone="violet">{t.changes} changes</Chip>
            <Chip tone="blue">+{t.pagesAdded} pages</Chip>
            <Chip tone="slate">{t.pagesUpdated} updated</Chip>
            <Chip tone="red">−{t.pagesRemoved} removed</Chip>
            <Chip tone="amber">{t.pricingOfferChanges} pricing/offer signals</Chip>
          </div>

          {/* Per-competitor velocity */}
          <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Competitor</th>
                  <th className="px-3 py-2 font-medium">+ Pages</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2 font-medium">− Pages</th>
                  <th className="px-3 py-2 font-medium">Pricing/offer</th>
                  <th className="px-3 py-2 font-medium">Top changes</th>
                </tr>
              </thead>
              <tbody>
                {digest.competitors.map((c) => (
                  <tr key={c.domain} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-stone-900">{c.domain}</td>
                    <td className="px-3 py-2"><Chip tone="blue">+{c.pagesAdded}</Chip></td>
                    <td className="px-3 py-2"><Chip tone="slate">{c.pagesUpdated}</Chip></td>
                    <td className="px-3 py-2"><Chip tone="red">−{c.pagesRemoved}</Chip></td>
                    <td className="px-3 py-2">
                      {c.pricingOfferChanges > 0 ? (
                        <Chip tone="amber">{c.pricingOfferChanges}</Chip>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <ul className="space-y-1">
                        {c.topChanges.map((tc, i) => (
                          <li key={i} className="flex items-center gap-1.5 text-[12.5px] text-stone-600">
                            <Chip tone={changeTone(tc.changeType)}>{CHANGE_LABELS[tc.changeType] ?? tc.changeType}</Chip>
                            <span className="truncate" title={tc.summary ?? tc.url}>
                              {tc.summary ? truncate(tc.summary, 70) : shortUrl(tc.url)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* SERP presence */}
          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-stone-800">
              Keyword presence — watched competitors in the top 10
            </h3>
            {!digest.serpAvailable ? (
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-[12.5px] text-stone-600">
                SERP vendor unavailable this week — keyword presence skipped (no
                SERP vendor is configured; the digest degrades gracefully
                instead of failing).
              </div>
            ) : digest.serpPresence.length === 0 ? (
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-[12.5px] text-stone-500">
                No watched competitor in the top 10 for tracked keywords this week.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                      <th className="px-3 py-2 font-medium">Keyword</th>
                      <th className="px-3 py-2 font-medium">Competitor</th>
                      <th className="px-3 py-2 font-medium">Position</th>
                      <th className="px-3 py-2 font-medium">Joined page change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {digest.serpPresence.map((s, i) => (
                      <tr key={i} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                        <td className="px-3 py-2 font-medium text-stone-900">{s.keyword}</td>
                        <td className="px-3 py-2 text-stone-600">{s.competitorDomain}</td>
                        <td className="px-3 py-2 text-stone-600">#{s.position}</td>
                        <td className="px-3 py-2">
                          {s.backedByPageChange ? (
                            <Chip tone="violet">page change this week</Chip>
                          ) : (
                            <span className="text-stone-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Review velocity status */}
          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-stone-800">
              Review velocity — licensed adapters
            </h3>
            <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">This week</th>
                    <th className="px-3 py-2 font-medium">Avg rating</th>
                    <th className="px-3 py-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {digest.reviewVelocity.map((rv, i) => (
                    <tr key={i} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                      <td className="px-3 py-2 font-medium capitalize text-stone-900">{rv.source}</td>
                      <td className="px-3 py-2">
                        <Chip tone={rv.status === "ok" ? "green" : "slate"}>{rv.status}</Chip>
                      </td>
                      <td className="px-3 py-2 text-stone-600">{rv.reviewsThisWeek}</td>
                      <td className="px-3 py-2 text-stone-600">
                        {rv.avgRating !== null ? rv.avgRating.toFixed(1) : "—"}
                      </td>
                      <td className="max-w-[380px] px-3 py-2 text-[12.5px] text-stone-500">
                        {rv.detail ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-[12px] text-stone-400">
              Run per-business pulls from the Reviews tab — the digest only
              reports adapter availability, never scraped data.
            </p>
          </div>

          {/* Google Alerts baseline (docs only — never scraped) */}
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
            <div className="mb-2 flex items-center gap-2">
              <Bell size={14} className="text-stone-500" />
              <span className="text-[13px] font-semibold text-stone-800">Google Alerts baseline</span>
              <select
                value={alertDomain}
                onChange={(e) => setAlertDomainPick(e.target.value)}
                className={inputCls}
              >
                {digest.competitors.map((c) => (
                  <option key={c.domain} value={c.domain}>
                    {c.domain}
                  </option>
                ))}
              </select>
            </div>
            <div className="whitespace-pre-line text-[12.5px] leading-relaxed text-stone-600">
              {googleAlertsGuidance(alertDomain || "competitor.com")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Reviews tab ──────────────────────────────────────────────────────────────

const REVIEW_SOURCES = [
  { id: "yelp", label: "Yelp Fusion (free tier)", icon: Star },
  { id: "dataforseo", label: "DataForSEO Business Data ($0.012/task)", icon: Newspaper },
  { id: "gbp", label: "GBP (owned listings)", icon: ListChecks },
] as const;

function ReviewsTab() {
  const [source, setSource] = useState<(typeof REVIEW_SOURCES)[number]["id"]>("yelp");
  const [businessId, setBusinessId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pull, setPull] = useState<ReviewPull | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runPull = useCallback(async () => {
    setPulling(true);
    setError(null);
    setPull(null);
    try {
      const body: Record<string, unknown> = { source };
      if (source === "yelp") {
        if (!businessId.trim()) throw new Error("businessId is required for Yelp");
        body.businessId = businessId.trim();
      } else if (source === "dataforseo") {
        const la = Number(lat);
        const ln = Number(lng);
        if (!keyword.trim() || !Number.isFinite(la) || !Number.isFinite(ln)) {
          throw new Error("keyword, lat, and lng are required for DataForSEO Business Data");
        }
        body.keyword = keyword.trim();
        body.lat = la;
        body.lng = ln;
      }
      const r = await fetch("/api/intelligence/fleet/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "review pull failed");
      setPull(d as ReviewPull);
    } catch (e) {
      setError(e instanceof Error ? e.message : "review pull failed");
    } finally {
      setPulling(false);
    }
  }, [source, businessId, keyword, lat, lng]);

  return (
    <div>
      <div className="mb-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-[12.5px] text-stone-600">
        <span className="font-medium text-stone-800">Licensed paths only. </span>
        Yelp Fusion (free tier), DataForSEO Business Data (metered through M6),
        and the GBP API for owned listings. No G2/Capterra/Trustpilot scraping —
        ever. Sentiment mining runs only on your own licensed data.
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} className={inputCls}>
          {REVIEW_SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {source === "yelp" && (
          <input
            value={businessId}
            onChange={(e) => setBusinessId(e.target.value)}
            placeholder="Yelp business ID"
            className={`${inputCls} w-64`}
          />
        )}
        {source === "dataforseo" && (
          <>
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="Business name" className={`${inputCls} w-56`} />
            <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="lat" className={`${inputCls} w-24`} />
            <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="lng" className={`${inputCls} w-24`} />
          </>
        )}
        <button onClick={runPull} disabled={pulling} className={btnPrimary}>
          {pulling ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Pull reviews
        </button>
      </div>
      {error && <p className="mb-3 text-[13px] text-red-600">{error}</p>}

      {pull && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={pull.result.status === "ok" ? "green" : "slate"}>{pull.result.status}</Chip>
            <span className="text-[13px] text-stone-600">
              {pull.velocity.reviewsThisWeek} reviews this week
              {pull.velocity.avgRating !== null && ` · avg ${pull.velocity.avgRating.toFixed(1)}★`}
            </span>
          </div>
          {pull.result.detail && (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-[12.5px] text-stone-600">
              {pull.result.detail}
            </div>
          )}
          {pull.themes.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2 font-medium">Complaint theme (heuristic, your data only)</th>
                    <th className="px-3 py-2 font-medium">Mentions</th>
                    <th className="px-3 py-2 font-medium">Example</th>
                  </tr>
                </thead>
                <tbody>
                  {pull.themes.map((th) => (
                    <tr key={th.theme} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                      <td className="px-3 py-2 font-medium capitalize text-stone-900">{th.theme.replace(/_/g, " ")}</td>
                      <td className="px-3 py-2">
                        <Chip tone="amber">{th.mentions}</Chip>
                      </td>
                      <td className="max-w-[420px] truncate px-3 py-2 text-stone-600" title={th.example}>
                        “{truncate(th.example, 90)}”
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────

const TABS = [
  { id: "changes", label: "Changes", icon: Radar },
  { id: "watchlist", label: "Watchlist", icon: Eye },
  { id: "digest", label: "Weekly digest", icon: Newspaper },
  { id: "reviews", label: "Review velocity", icon: Star },
] as const;

export function CompetitorsClient({ projects }: { projects: Project[] }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("changes");
  return (
    <div>
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
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {tab === "changes" && <ChangesTab projects={projects} />}
      {tab === "watchlist" && <WatchlistTab projects={projects} />}
      {tab === "digest" && <DigestTab projects={projects} />}
      {tab === "reviews" && <ReviewsTab />}
    </div>
  );
}
