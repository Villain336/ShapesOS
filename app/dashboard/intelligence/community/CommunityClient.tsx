// Marketr — community engagement client (Phase 10 M8).
// Tabs: [Opportunity queue] [Posted outcomes] [Sources & setup].
// House style: Agentic OS (docs/design/DESIGN.md) — dense tables, black primaries, Lucide only, canvas shell.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  ExternalLink,
  Inbox,
  Loader2,
  MessagesSquare,
  Plus,
  RefreshCw,
  Rss,
  X,
} from "lucide-react";

// ── Small atoms (StudioApp.tsx pattern) ──────────────────────────────────────

// Source badges are category chips — neutral by default.
function SourceBadge({ source }: { source: string }) {
  const labels: Record<string, string> = {
    hacker_news: "HN",
    reddit: "Reddit",
    rss: "RSS",
  };
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-[10px] font-semibold leading-tight text-muted shadow-control">
      {labels[source] ?? source}
    </span>
  );
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

const btnPrimary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

const btnGhost =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

function ageOf(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface QueueItem {
  id: string;
  source: string;
  thread: string;
  threadUrl: string;
  reason: string;
  draft: string;
  signals: string;
  matchedKeywords: string[];
  feedName: string | null;
  author: string | null;
  createdAt: string;
  expiresAt: string;
}

interface Outcome {
  approvalId: string;
  source: string;
  threadTitle: string;
  threadUrl: string;
  draftExcerpt: string;
  approvalStatus: string;
  postedAt: string | null;
  upvotes: number | null;
  replies: number | null;
  traffic: number | null;
  note: string | null;
}

interface ScanSource {
  source: string;
  status: "ok" | "skipped" | "error";
  detail: string;
}

interface ScanOpportunity {
  source: string;
  title: string;
  url: string;
  author: string | null;
  feedName: string | null;
  score: number;
  signals: string[];
  matchedKeywords: string[];
  relevanceReason: string;
  createdAt: string;
}

interface ScanReport {
  dryRun: boolean;
  scannedAt: string;
  sources: ScanSource[];
  opportunities: ScanOpportunity[];
  queued: { approvalId: string; source: string; title: string; url: string; draft: string }[];
  tasteRejected: { source: string; title: string; url: string; failures: string[] }[];
}

const TABS = [
  { id: "queue", label: "Opportunity queue", icon: MessagesSquare },
  { id: "outcomes", label: "Posted outcomes", icon: BarChart3 },
  { id: "sources", label: "Sources & setup", icon: Rss },
] as const;

// ── Queue tab ────────────────────────────────────────────────────────────────

function QueueTab() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [feeds, setFeeds] = useState("");
  const [maxDrafts, setMaxDrafts] = useState(5);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/intelligence/community/opportunities");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load queue.");
      setItems(body.opportunities as QueueItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load queue.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (i) =>
        (sourceFilter === "all" || i.source === sourceFilter) &&
        (!q ||
          i.thread.toLowerCase().includes(q) ||
          i.reason.toLowerCase().includes(q) ||
          i.draft.toLowerCase().includes(q)),
    );
  }, [items, query, sourceFilter]);

  async function runScan(dryRun: boolean) {
    setScanning(true);
    setError(null);
    setReport(null);
    try {
      const rssFeeds = feeds
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const m = line.match(/^(.*?)\s*\|\s*(https?:\/\/\S+)\s*$/);
          return m ? { name: m[1].trim(), url: m[2].trim() } : { name: "feed", url: line };
        });
      const res = await fetch("/api/intelligence/community/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rssFeeds, maxDrafts, dryRun }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Scan failed.");
      setReport(body as ScanReport);
      if (!dryRun) await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* filter toolbar + scan actions */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search threads, reasons, drafts…"
          className={`${inputCls} w-56`}
        />
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className={inputCls}
          aria-label="Filter by source"
        >
          <option value="all">All sources</option>
          <option value="hacker_news">Hacker News</option>
          <option value="reddit">Reddit</option>
          <option value="rss">RSS</option>
        </select>
        <select
          value={maxDrafts}
          onChange={(e) => setMaxDrafts(Number(e.target.value))}
          className={inputCls}
          aria-label="Drafts per scan"
        >
          {[3, 5, 8, 10].map((n) => (
            <option key={n} value={n}>
              {n} drafts/scan
            </option>
          ))}
        </select>
        <button onClick={() => runScan(true)} disabled={scanning} className={btnGhost}>
          {scanning ? <Loader2 size={14} className="aos-spin" /> : <ExternalLink size={14} />}
          Preview opportunities
        </button>
        <button onClick={() => runScan(false)} disabled={scanning} className={btnPrimary}>
          {scanning ? <Loader2 size={14} className="aos-spin" /> : <Plus size={14} />}
          Scan & draft
        </button>
        <button onClick={load} className={btnGhost} aria-label="Refresh queue">
          <RefreshCw size={14} />
        </button>
        <a href="/dashboard/approvals" className={`${btnGhost} ml-auto`}>
          <Inbox size={14} />
          Open approvals inbox
        </a>
      </div>

      <div className="rounded-lg border border-line bg-canvas px-3 py-2 text-[12px] text-muted">
        Draft-first, always: scanning drafts replies and queues them in the approvals inbox.
        A human edits and posts natively — ShapesOS never posts, votes, or messages on your
        behalf. Drafts failing the taste check never reach the inbox.
      </div>

      <details className="rounded-lg border border-line bg-paper px-3 py-2">
        <summary className="cursor-pointer text-[13px] font-medium text-muted">
          RSS feeds for this scan (optional)
        </summary>
        <textarea
          value={feeds}
          onChange={(e) => setFeeds(e.target.value)}
          rows={2}
          placeholder={"Niche SEO Forum | https://forum.example/rss\nhttps://blog.example/atom"}
          className={`${inputCls} mt-2 w-full font-mono text-[12px]`}
        />
      </details>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text">
          <span className="size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />
          {error}
          <button onClick={() => setError(null)} className="ml-auto" aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}

      {report && (
        <div className="rounded-lg border border-line bg-canvas px-3 py-2.5 text-[13px]">
          <div className="font-medium text-ink">
            Scan {report.dryRun ? "preview" : "complete"} — {report.opportunities.length}{" "}
            opportunit{report.opportunities.length === 1 ? "y" : "ies"} found
            {!report.dryRun && (
              <>
                , {report.queued.length} drafted, {report.tasteRejected.length} taste-rejected
              </>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-[12px] text-muted">
            {report.sources.map((s) => (
              <span key={s.source}>
                <SourceBadge source={s.source} /> {s.status}: {s.detail}
              </span>
            ))}
          </div>
          {report.dryRun && report.opportunities.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              {report.opportunities.slice(0, 8).map((o) => (
                <li key={o.url}>
                  <a href={o.url} target="_blank" rel="noreferrer" className="text-ink hover:underline">
                    {o.title}
                  </a>{" "}
                  <span className="text-muted">— {o.relevanceReason}</span>
                </li>
              ))}
            </ul>
          )}
          {report.tasteRejected.length > 0 && (
            <div className="mt-2 text-[12px] text-muted">
              {report.tasteRejected.length} draft(s) failed the taste check and were logged, not
              queued: {report.tasteRejected.map((t) => t.failures[0]).join(" · ")}
            </div>
          )}
        </div>
      )}

      {items === null ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={16} className="aos-spin" />
          Loading opportunity queue…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-paper px-6 py-12 text-center">
          <MessagesSquare size={28} className="text-subtle" />
          <div className="text-[14px] font-semibold text-ink">Queue is empty</div>
          <div className="max-w-[360px] text-[13px] text-muted">
            Run “Scan & draft” to find live threads and draft replies. Passing drafts land in the
            approvals inbox for your sign-off.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-paper">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Thread</th>
                <th className="px-3 py-2 font-medium">Why relevant</th>
                <th className="px-3 py-2 font-medium">Draft</th>
                <th className="px-3 py-2 font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((i) => (
                <tr key={i.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2.5 align-top">
                    <SourceBadge source={i.source} />
                    {i.feedName && <div className="mt-1 text-[11px] text-subtle">{i.feedName}</div>}
                  </td>
                  <td className="max-w-[220px] px-3 py-2.5 align-top">
                    <a
                      href={i.threadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-ink hover:text-ink hover:underline"
                      title={i.thread}
                    >
                      <span className="line-clamp-2">{i.thread}</span>
                    </a>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-subtle">
                      {i.author && <span>by {i.author}</span>}
                      <ArrowUpRight size={11} />
                    </div>
                  </td>
                  <td className="max-w-[220px] px-3 py-2.5 align-top text-[12px] text-muted">
                    <span className="line-clamp-3" title={i.reason}>
                      {i.reason}
                    </span>
                    {i.matchedKeywords.length > 0 && (
                      <div className="mt-1 text-[11px] text-subtle">
                        {i.matchedKeywords.slice(0, 3).join(", ")}
                      </div>
                    )}
                  </td>
                  <td className="max-w-[260px] px-3 py-2.5 align-top">
                    <p
                      className={`text-[12px] text-muted ${expanded === i.id ? "" : "line-clamp-3"}`}
                      title={i.draft}
                    >
                      {i.draft}
                    </p>
                    <button
                      onClick={() => setExpanded(expanded === i.id ? null : i.id)}
                      className="mt-1 text-[11px] font-medium text-ink hover:underline"
                    >
                      {expanded === i.id ? "Show less" : "Show full draft"}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 align-top text-muted">
                    {ageOf(i.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[12px] text-muted">
        Drafts are decided in the{" "}
        <a href="/dashboard/approvals" className="font-medium text-ink hover:underline">
          approvals inbox
        </a>
        . Approving means “ok to post natively” — you still post it yourself, in your own voice.
      </p>
    </div>
  );
}

// ── Outcomes tab ─────────────────────────────────────────────────────────────

function OutcomesTab() {
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    approvalId: "",
    upvotes: "",
    replies: "",
    traffic: "",
    note: "",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const [oRes, qRes] = await Promise.all([
        fetch("/api/intelligence/community/outcomes"),
        fetch("/api/intelligence/community/opportunities"),
      ]);
      const oBody = await oRes.json();
      const qBody = await qRes.json();
      if (!oRes.ok) throw new Error(oBody.error ?? "Failed to load outcomes.");
      if (!qRes.ok) throw new Error(qBody.error ?? "Failed to load queue.");
      setOutcomes(oBody.outcomes as Outcome[]);
      setQueue(qBody.opportunities as QueueItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load outcomes.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function recordOutcome() {
    if (!form.approvalId) {
      setError("Pick a queued draft to record its outcome.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const num = (v: string) => (v.trim() === "" ? null : Number(v));
      const res = await fetch("/api/intelligence/community/outcomes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: form.approvalId,
          upvotes: num(form.upvotes),
          replies: num(form.replies),
          traffic: num(form.traffic),
          note: form.note.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to record outcome.");
      setForm({ approvalId: "", upvotes: "", replies: "", traffic: "", note: "" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record outcome.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-line bg-paper p-3">
        <div className="mb-2 text-[13px] font-semibold text-ink">
          Record a posted outcome
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Queued draft
            <select
              value={form.approvalId}
              onChange={(e) => setForm({ ...form, approvalId: e.target.value })}
              className={`${inputCls} w-64`}
            >
              <option value="">Select…</option>
              {(queue ?? []).map((q) => (
                <option key={q.id} value={q.id}>
                  {q.thread.slice(0, 60)}
                </option>
              ))}
            </select>
          </label>
          {[
            ["upvotes", "Upvotes"],
            ["replies", "Replies"],
            ["traffic", "Visits"],
          ].map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1 text-[12px] text-muted">
              {label}
              <input
                value={form[key as "upvotes" | "replies" | "traffic"]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                inputMode="numeric"
                placeholder="—"
                className={`${inputCls} w-24`}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Note
            <input
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="e.g. drove 3 demo signups"
              className={`${inputCls} w-56`}
            />
          </label>
          <button onClick={recordOutcome} disabled={saving} className={btnPrimary}>
            {saving ? <Loader2 size={14} className="aos-spin" /> : <CheckCircle2 size={14} />}
            Record posted
          </button>
        </div>
        <p className="mt-2 text-[12px] text-muted">
          After you post a draft natively, record what happened. Outcomes feed M3’s
          branded-mention tracking.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text">
          <span className="size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />
          {error}
          <button onClick={() => setError(null)} className="ml-auto" aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}

      {outcomes === null ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={16} className="aos-spin" />
          Loading outcomes…
        </div>
      ) : outcomes.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-paper px-6 py-12 text-center">
          <BarChart3 size={28} className="text-subtle" />
          <div className="text-[14px] font-semibold text-ink">No posted outcomes yet</div>
          <div className="max-w-[360px] text-[13px] text-muted">
            Post a queued draft natively, then record the outcome above to close the loop.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-paper">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Thread</th>
                <th className="px-3 py-2 font-medium">Posted</th>
                <th className="px-3 py-2 font-medium">Upvotes</th>
                <th className="px-3 py-2 font-medium">Replies</th>
                <th className="px-3 py-2 font-medium">Visits</th>
                <th className="px-3 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((o) => (
                <tr
                  key={o.approvalId}
                  className="border-b border-line last:border-0 hover:bg-hover-paper"
                >
                  <td className="px-3 py-2.5 align-top">
                    <SourceBadge source={o.source} />
                  </td>
                  <td className="max-w-[240px] px-3 py-2.5 align-top">
                    <a
                      href={o.threadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-ink hover:text-ink hover:underline"
                      title={o.threadTitle}
                    >
                      <span className="line-clamp-2">{o.threadTitle || "—"}</span>
                    </a>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 align-top text-muted">
                    {o.postedAt ? new Date(o.postedAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-2.5 align-top font-medium text-ink">
                    {o.upvotes ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 align-top font-medium text-ink">
                    {o.replies ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 align-top font-medium text-ink">
                    {o.traffic ?? "—"}
                  </td>
                  <td className="max-w-[200px] px-3 py-2.5 align-top text-[12px] text-muted">
                    <span className="line-clamp-2" title={o.note ?? ""}>
                      {o.note ?? "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Sources tab ──────────────────────────────────────────────────────────────

function SourcesTab() {
  const [feeds, setFeeds] = useState("");
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-line bg-paper p-4">
        <div className="flex items-center gap-2">
          <SourceBadge source="hacker_news" />
          <span className="text-[14px] font-semibold text-ink">Hacker News</span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-[10px] font-semibold text-muted shadow-control">
            <CheckCircle2 size={11} /> Live — no key needed
          </span>
        </div>
        <p className="mt-2 text-[13px] text-muted">
          Searched via the free Algolia HN Search API (stories + comments). Queries default to
          your tracked keywords plus competitor domains.
        </p>
      </div>

      <div className="rounded-lg border border-line bg-paper p-4">
        <div className="flex items-center gap-2">
          <SourceBadge source="reddit" />
          <span className="text-[14px] font-semibold text-ink">Reddit</span>
          <span className="ml-auto inline-flex items-center rounded-full bg-paper px-2 py-0.5 text-[10px] font-semibold text-muted shadow-control">
            Official API only — your own OAuth
          </span>
        </div>
        <div className="mt-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[12px] text-muted">
          ShapesOS never scrapes Reddit and never proxies it at platform scale. To enable Reddit
          opportunities, create a script app at reddit.com/prefs/apps (your own account), then
          supply the client ID, secret, refresh token, and username when running a scan. Read-only
          scope; nothing here posts, votes, or messages — you post natively. Note: Reddit wound
          down public API access Sept 30, 2026 and commercial pricing is reported around
          $12K/mo, so per-user OAuth is the only sustainable path.
        </div>
      </div>

      <div className="rounded-lg border border-line bg-paper p-4">
        <div className="flex items-center gap-2">
          <SourceBadge source="rss" />
          <span className="text-[14px] font-semibold text-ink">Niche forums (RSS)</span>
        </div>
        <p className="mt-2 text-[13px] text-muted">
          Paste forum/community feed URLs below — one per line, optionally as{" "}
          <code className="rounded-key bg-hover px-1 font-mono text-[12px]">Name | https://…/rss</code>.
          They’re sent with each scan (Discourse, NodeBB, Flarum, Substack feeds all work).
        </p>
        <textarea
          value={feeds}
          onChange={(e) => setFeeds(e.target.value)}
          rows={3}
          placeholder={"Niche SEO Forum | https://forum.example/rss\nhttps://blog.example/atom"}
          className={`${inputCls} mt-2 w-full font-mono text-[12px]`}
        />
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => {
              navigator.clipboard?.writeText(feeds).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className={btnGhost}
          >
            {copied ? "Copied" : "Copy feed list"}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-canvas px-3 py-2 text-[12px] text-muted">
        <span className="font-medium text-muted">Google Alerts baseline:</span> there is no
        Alerts API — use the free consumer product (google.com/alerts) for competitor mentions,
        then paste promising thread URLs into a scan’s context or post about them directly. M8
        never scrapes Alerts.
      </div>

      <div className="rounded-lg border border-line bg-canvas px-3 py-2 text-[12px] text-muted">
        <span className="font-medium text-muted">House rules:</span> one account, honest
        identity. No astroturfing, no fake engagement, no automation of votes or posts.
        Over-polished AI replies get punished by communities — every draft passes a taste check
        before it reaches your inbox.
      </div>
    </div>
  );
}

// ── Shell ────────────────────────────────────────────────────────────────────

export default function CommunityClient() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("queue");
  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-line">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
              tab === id
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      {tab === "queue" && <QueueTab />}
      {tab === "outcomes" && <OutcomesTab />}
      {tab === "sources" && <SourcesTab />}
    </div>
  );
}
