// Marketr — Wave 2 context.dev slice 2: knowledge client (tabs + tables) (Agentic OS).
// Sources tab: register form + source table with approve/reject/crawl.
// Crawl jobs tab: job history with pages/chunks/credits.
// Statuses follow the status color+shape law: crawl jobs are genuine agent
// runs (queued/running/complete/failed); monitors are subscriptions
// (active/paused chips).

"use client";

import { useState, Fragment } from "react";
import { Plus, Globe, Check, X, Play, Loader2, Pause, Radar } from "lucide-react";
import {
  Chip,
  inputCls,
  btnPrimary,
  btnGhost,
  btnRun,
  btnApprove,
  btnDeny,
  type ChipTone,
} from "../corpus/brain/brain-ui";

type Source = {
  id: string;
  url: string;
  sourceType: string;
  cadence: string;
  status: string;
  domain: string;
  _count: { jobs: number; chunks: number };
};

type Job = {
  id: string;
  status: string;
  pagesFetched: number;
  creditsUsed: number;
  error: string | null;
  createdAt: string;
  source: { url: string; sourceType: string } | null;
};

type Monitor = {
  id: string;
  name: string;
  url: string;
  cadence: string;
  status: string;
  lastCheckedAt: string | null;
  lastChangeAt: string | null;
  consecutiveFailures: number;
  autoResearch: boolean;
  _count: { changes: number };
};

type MonitorChange = {
  id: string;
  detectedAt: string;
  digest: string;
  excerpt: string | null;
  researchTaskId: string | null;
};

type BrandDiffEntry = {
  field: string;
  current: string | null;
  proposed: string | null;
};

type BrandSync = {
  id: string;
  domain: string;
  status: string;
  diffJson: BrandDiffEntry[];
  creditsUsed: number;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  brandKit: { id: string; name: string; isDefault: boolean } | null;
};

type BrandKitOption = { id: string; name: string; isDefault: boolean };

/** Status chip with the shape for its tone, per the status color+shape law
 *  (Chip already renders the shape for its tone). */
function StatusChip({ tone, children }: { tone: ChipTone; children: React.ReactNode }) {
  return <Chip tone={tone}>{children}</Chip>;
}

function sourceStatusTone(status: string): ChipTone {
  if (status === "pending_approval") return "needs";
  if (status === "archived") return "neutral";
  return "done";
}

function jobStatusTone(status: string): ChipTone {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "queued") return "queued";
  return "done";
}

function syncStatusTone(status: string): ChipTone {
  if (status === "pending_approval") return "needs";
  if (status === "applied") return "done";
  if (status === "rejected") return "deny";
  if (status === "failed") return "failed";
  return "neutral";
}

export function KnowledgeClient({
  initialSources,
  initialJobs,
  initialMonitors,
  initialSyncs,
  initialKits,
  canEdit,
}: {
  initialSources: Source[];
  initialJobs: Job[];
  initialMonitors: Monitor[];
  initialSyncs: BrandSync[];
  initialKits: BrandKitOption[];
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<"sources" | "jobs" | "monitors" | "brand">("sources");
  const [sources, setSources] = useState(initialSources);
  const [jobs, setJobs] = useState(initialJobs);
  const [monitors, setMonitors] = useState(initialMonitors);
  const [syncs, setSyncs] = useState(initialSyncs);
  const [kits] = useState(initialKits);
  const [showForm, setShowForm] = useState(false);
  const [showMonitorForm, setShowMonitorForm] = useState(false);
  const [showSyncForm, setShowSyncForm] = useState(false);
  const [url, setUrl] = useState("");
  const [sourceType, setSourceType] = useState("page");
  const [monitorName, setMonitorName] = useState("");
  const [monitorUrl, setMonitorUrl] = useState("");
  const [monitorCadence, setMonitorCadence] = useState("daily");
  const [syncDomain, setSyncDomain] = useState("");
  const [syncKitId, setSyncKitId] = useState("");
  const [expandedMonitor, setExpandedMonitor] = useState<string | null>(null);
  const [expandedSync, setExpandedSync] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, MonitorChange[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const [s, j, m, b] = await Promise.all([
      fetch("/api/knowledge/contextdev/sources").then((r) => r.json()),
      fetch("/api/knowledge/contextdev/jobs").then((r) => r.json()),
      fetch("/api/knowledge/contextdev/monitors").then((r) => r.json()),
      fetch("/api/knowledge/contextdev/brand-sync").then((r) => r.json()),
    ]);
    if (s.sources) setSources(s.sources);
    if (j.jobs) setJobs(j.jobs);
    if (m.monitors) setMonitors(m.monitors);
    if (b.syncs) setSyncs(b.syncs);
  }

  async function post(path: string, body?: object) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function addSource() {
    setError(null);
    setNotice(null);
    setBusy("add");
    try {
      const { source } = await post("/api/knowledge/contextdev/sources", { url, sourceType });
      setUrl("");
      setShowForm(false);
      setNotice(
        source.status === "active"
          ? "Source activated — your own domain crawls immediately."
          : "Source saved as pending approval — approve it to enable crawling.",
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add source");
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, action: "approve" | "reject" | "crawl") {
    setError(null);
    setNotice(null);
    setBusy(`${action}:${id}`);
    try {
      if (action === "crawl") {
        const { result } = await post(`/api/knowledge/contextdev/sources/${id}/crawl`, { maxPages: 25 });
        setNotice(
          `Crawl complete: ${result.pagesFetched} pages, ${result.chunksWritten} chunks, ${result.creditsUsed} credits.`,
        );
      } else {
        await post(`/api/knowledge/contextdev/sources/${id}/${action}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function addMonitor() {
    setError(null);
    setNotice(null);
    setBusy("add-monitor");
    try {
      await post("/api/knowledge/contextdev/monitors", {
        name: monitorName,
        url: monitorUrl,
        cadence: monitorCadence,
      });
      setMonitorName("");
      setMonitorUrl("");
      setShowMonitorForm(false);
      setNotice("Monitor registered — its first run captures the baseline, then it watches for changes.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add monitor");
    } finally {
      setBusy(null);
    }
  }

  async function monitorAct(id: string, action: "run" | "pause" | "resume") {
    setError(null);
    setNotice(null);
    setBusy(`monitor:${action}:${id}`);
    try {
      if (action === "run") {
        const { result } = await post(`/api/knowledge/contextdev/monitors/${id}/run`);
        setNotice(
          result.outcome === "changed"
            ? `Change detected: ${result.changeId ? "digest recorded" : ""}${result.researchTaskId ? " + research task spawned" : ""}.`
            : `Monitor check: ${result.outcome}${result.error ? ` — ${result.error}` : ""}.`,
        );
      } else {
        const res = await fetch(`/api/knowledge/contextdev/monitors/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: action === "pause" ? "paused" : "active" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function proposeSync() {
    setError(null);
    setNotice(null);
    setBusy("propose-sync");
    try {
      const { sync } = await post("/api/knowledge/contextdev/brand-sync", {
        domain: syncDomain,
        brandKitId: syncKitId || undefined,
      });
      setSyncDomain("");
      setSyncKitId("");
      setShowSyncForm(false);
      setNotice(
        sync.status === "unchanged"
          ? "Brand profile matches the kit — nothing to approve."
          : "Brand profile fetched — review the diff, then approve or reject.",
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not fetch brand profile");
    } finally {
      setBusy(null);
    }
  }

  async function syncAct(id: string, action: "approve" | "reject") {
    setError(null);
    setNotice(null);
    setBusy(`sync:${action}:${id}`);
    try {
      await post(`/api/knowledge/contextdev/brand-sync/${id}/${action}`);
      setNotice(
        action === "approve"
          ? "Brand kit updated — the dashboard theme picks up the new colors on the next render."
          : "Sync proposal rejected — the live kit is untouched.",
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function toggleChanges(id: string) {
    if (expandedMonitor === id) {
      setExpandedMonitor(null);
      return;
    }
    setExpandedMonitor(id);
    if (!changes[id]) {
      try {
        const data = await fetch(`/api/knowledge/contextdev/monitors/${id}/changes`).then((r) => r.json());
        if (data.changes) setChanges((c) => ({ ...c, [id]: data.changes }));
      } catch {
        /* non-fatal */
      }
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border-[1.5px] border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
        >
          <span className="aos-shape aos-shape--failed mt-1 shrink-0" style={{ "--aos-shape-size": "10px" } as React.CSSProperties} />
          {error}
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-lg bg-paper px-3 py-2 text-sm text-ink shadow-hairline">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          {notice}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex gap-1 border-b border-line">
          {(
            [
              ["sources", "Sources"],
              ["jobs", "Crawl jobs"],
              ["monitors", "Monitors"],
              ["brand", "Brand sync"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 pb-2 text-sm font-medium ${
                tab === key
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {canEdit && tab === "sources" && (
          <button
            onClick={() => setShowForm((v) => !v)}
            className={btnPrimary}
          >
            <Plus className="h-3.5 w-3.5" /> Add source
          </button>
        )}
        {canEdit && tab === "monitors" && (
          <button
            onClick={() => setShowMonitorForm((v) => !v)}
            className={btnPrimary}
          >
            <Radar className="h-3.5 w-3.5" /> Watch a page
          </button>
        )}
        {canEdit && tab === "brand" && (
          <button
            onClick={() => setShowSyncForm((v) => !v)}
            className={btnPrimary}
          >
            <Plus className="h-3.5 w-3.5" /> Sync brand
          </button>
        )}
      </div>

      {showForm && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-paper p-3 shadow-hairline">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs font-semibold text-muted">
            URL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/docs or sitemap.xml"
              className={`${inputCls} h-control`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Type
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
              className={`${inputCls} h-control`}
            >
              <option value="page">Single page</option>
              <option value="sitemap">Sitemap (crawl)</option>
              <option value="brand">Brand profile</option>
            </select>
          </label>
          <button
            onClick={addSource}
            disabled={busy === "add" || !url.trim()}
            className={btnPrimary}
          >
            {busy === "add" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Register
          </button>
        </div>
      )}

      {showMonitorForm && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-paper p-3 shadow-hairline">
          <label className="flex min-w-40 flex-col gap-1 text-xs font-semibold text-muted">
            Name
            <input
              value={monitorName}
              onChange={(e) => setMonitorName(e.target.value)}
              placeholder="Competitor pricing page"
              className={`${inputCls} h-control`}
            />
          </label>
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs font-semibold text-muted">
            URL to watch
            <input
              value={monitorUrl}
              onChange={(e) => setMonitorUrl(e.target.value)}
              placeholder="https://competitor.com/pricing"
              className={`${inputCls} h-control`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Cadence
            <select
              value={monitorCadence}
              onChange={(e) => setMonitorCadence(e.target.value)}
              className={`${inputCls} h-control`}
            >
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <button
            onClick={addMonitor}
            disabled={busy === "add-monitor" || !monitorName.trim() || !monitorUrl.trim()}
            className={btnPrimary}
          >
            {busy === "add-monitor" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Watch
          </button>
        </div>
      )}

      {showSyncForm && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-paper p-3 shadow-hairline">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs font-semibold text-muted">
            Domain
            <input
              value={syncDomain}
              onChange={(e) => setSyncDomain(e.target.value)}
              placeholder="acme.com"
              className={`${inputCls} h-control`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Target kit
            <select
              value={syncKitId}
              onChange={(e) => setSyncKitId(e.target.value)}
              className={`${inputCls} h-control`}
            >
              <option value="">Default kit (or create new)</option>
              {kits.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                  {k.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={proposeSync}
            disabled={busy === "propose-sync" || !syncDomain.trim()}
            className={btnPrimary}
          >
            {busy === "propose-sync" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Fetch & diff
          </button>
        </div>
      )}

      {tab === "sources" ? (
        <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Chunks</th>
                <th className="px-3 py-2 text-right">Crawls</th>
                {canEdit && <th className="px-3 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5 font-medium text-ink">
                      <Globe className="h-3.5 w-3.5 text-subtle" />
                      <span className="max-w-72 truncate">{s.url}</span>
                    </div>
                    <div className="pl-5 text-xs text-subtle">{s.domain}</div>
                  </td>
                  <td className="px-3 py-2 text-muted">{s.sourceType}</td>
                  <td className="px-3 py-2">
                    <StatusChip tone={sourceStatusTone(s.status)}>
                      {s.status.replace("_", " ")}
                    </StatusChip>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">{s._count.chunks}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">{s._count.jobs}</td>
                  {canEdit && (
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1.5">
                        {s.status === "pending_approval" && (
                          <>
                            <button
                              title="Approve"
                              onClick={() => act(s.id, "approve")}
                              disabled={busy !== null}
                              className={btnApprove}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button
                              title="Reject"
                              onClick={() => act(s.id, "reject")}
                              disabled={busy !== null}
                              className={btnDeny}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                        {s.status === "active" && (
                          <button
                            title="Crawl now"
                            onClick={() => act(s.id, "crawl")}
                            disabled={busy !== null}
                            className={btnRun}
                          >
                            {busy === `crawl:${s.id}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                            Crawl
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {sources.length === 0 && (
                <tr>
                  <td colSpan={canEdit ? 6 : 5} className="px-3 py-8 text-center text-subtle">
                    No sources yet — add your first page, sitemap, or brand profile.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : tab === "jobs" ? (
        <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Pages</th>
                <th className="px-3 py-2 text-right">Credits</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2">
                    <div className="max-w-80 truncate font-medium text-ink">
                      {j.source?.url ?? "—"}
                    </div>
                    <div className="text-xs text-subtle">
                      {new Date(j.createdAt).toLocaleString()}
                      {j.error && <span className="text-failed-text"> · {j.error}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <StatusChip tone={jobStatusTone(j.status)}>{j.status}</StatusChip>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">{j.pagesFetched}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">{j.creditsUsed}</td>
                </tr>
              ))}
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-subtle">
                    No crawl jobs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : tab === "monitors" ? (
        <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                <th className="px-3 py-2">Monitor</th>
                <th className="px-3 py-2">Cadence</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Changes</th>
                <th className="px-3 py-2">Last checked</th>
                {canEdit && <th className="px-3 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {monitors.map((m) => (
                <Fragment key={m.id}>
                  <tr className="border-b border-line hover:bg-hover-paper">
                    <td className="px-3 py-2">
                      <button
                        onClick={() => toggleChanges(m.id)}
                        className="max-w-80 truncate text-left font-medium text-ink hover:underline"
                        title="Show detected changes"
                      >
                        {m.name}
                      </button>
                      <div className="max-w-80 truncate text-xs text-subtle">{m.url}</div>
                      {m.consecutiveFailures > 0 && (
                        <div className="text-xs text-failed-text">
                          {m.consecutiveFailures} consecutive failures
                          {m.status === "paused" && " — auto-paused"}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">{m.cadence}</td>
                    <td className="px-3 py-2">
                      <Chip tone={m.status === "active" ? "neutral" : "paused"}>{m.status}</Chip>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      {m._count.changes}
                    </td>
                    <td className="px-3 py-2 text-xs text-subtle">
                      {m.lastCheckedAt ? new Date(m.lastCheckedAt).toLocaleString() : "never"}
                    </td>
                    {canEdit && (
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1.5">
                          <button
                            onClick={() => monitorAct(m.id, "run")}
                            disabled={busy === `monitor:run:${m.id}` || m.status !== "active"}
                            className={btnRun}
                            title="Check now"
                          >
                            {busy === `monitor:run:${m.id}` ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Play className="h-3 w-3" />
                            )}
                            Run
                          </button>
                          <button
                            onClick={() => monitorAct(m.id, m.status === "active" ? "pause" : "resume")}
                            disabled={busy?.startsWith(`monitor:pause:${m.id}`) || busy?.startsWith(`monitor:resume:${m.id}`)}
                            className={btnGhost}
                          >
                            <Pause className="h-3 w-3" />
                            {m.status === "active" ? "Pause" : "Resume"}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                  {expandedMonitor === m.id && (
                    <tr key={`${m.id}-changes`}>
                      <td colSpan={canEdit ? 6 : 5} className="border-b border-line bg-canvas px-4 py-2">
                        {changes[m.id] ? (
                          changes[m.id].length === 0 ? (
                            <p className="py-2 text-xs text-subtle">
                              No changes detected since baselining.
                            </p>
                          ) : (
                            <ul className="divide-y divide-line">
                              {changes[m.id].map((c) => (
                                <li key={c.id} className="py-2">
                                  <div className="flex items-center gap-2 text-xs">
                                    <span className="font-medium text-ink">{c.digest}</span>
                                    <span className="text-subtle">
                                      {new Date(c.detectedAt).toLocaleString()}
                                    </span>
                                    {c.researchTaskId && (
                                      <Chip tone="neutral">research spawned</Chip>
                                    )}
                                  </div>
                                  {c.excerpt && (
                                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-night p-2 font-mono text-xs text-night-text">
                                      {c.excerpt}
                                    </pre>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )
                        ) : (
                          <p className="py-2 text-xs text-subtle">Loading changes…</p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {monitors.length === 0 && (
                <tr>
                  <td colSpan={canEdit ? 6 : 5} className="px-3 py-8 text-center text-subtle">
                    No monitors yet — watch a competitor pricing page, changelog, or docs.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                <th className="px-3 py-2">Domain</th>
                <th className="px-3 py-2">Target kit</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Changes</th>
                <th className="px-3 py-2 text-right">Credits</th>
                <th className="px-3 py-2">Proposed</th>
                {canEdit && <th className="px-3 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {syncs.map((s) => (
                <Fragment key={s.id}>
                  <tr className="border-b border-line hover:bg-hover-paper">
                    <td className="px-3 py-2">
                      <button
                        onClick={() => setExpandedSync(expandedSync === s.id ? null : s.id)}
                        className="font-medium text-ink hover:underline"
                        title="Show diff"
                      >
                        {s.domain}
                      </button>
                      {s.error && <div className="text-xs text-failed-text">{s.error}</div>}
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {s.brandKit ? (
                        <>
                          {s.brandKit.name}
                          {s.brandKit.isDefault && (
                            <span className="ml-1 text-[0.6875rem] text-subtle">(default)</span>
                          )}
                        </>
                      ) : (
                        <span className="text-subtle">new kit on approve</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusChip tone={syncStatusTone(s.status)}>
                        {s.status.replace("_", " ")}
                      </StatusChip>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      {s.diffJson.length}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      {s.creditsUsed}
                    </td>
                    <td className="px-3 py-2 text-xs text-subtle">
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                    {canEdit && (
                      <td className="px-3 py-2">
                        {s.status === "pending_approval" ? (
                          <div className="flex justify-end gap-1.5">
                            <button
                              onClick={() => syncAct(s.id, "approve")}
                              disabled={busy === `sync:approve:${s.id}`}
                              className={btnApprove}
                            >
                              {busy === `sync:approve:${s.id}` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Check className="h-3 w-3" />
                              )}
                              Approve
                            </button>
                            <button
                              onClick={() => syncAct(s.id, "reject")}
                              disabled={busy === `sync:reject:${s.id}`}
                              className={btnDeny}
                            >
                              <X className="h-3 w-3" />
                              Reject
                            </button>
                          </div>
                        ) : (
                          <div className="text-right text-xs text-subtle">
                            {s.decidedAt ? new Date(s.decidedAt).toLocaleString() : "—"}
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                  {expandedSync === s.id && s.diffJson.length > 0 && (
                    <tr key={`${s.id}-diff`}>
                      <td colSpan={canEdit ? 7 : 6} className="border-b border-line bg-canvas px-4 py-2">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-xs font-semibold text-muted">
                              <th className="py-1 pr-3">Field</th>
                              <th className="py-1 pr-3">Current</th>
                              <th className="py-1">Proposed</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.diffJson.map((d) => (
                              <tr key={d.field} className="border-t border-line">
                                <td className="py-1 pr-3 font-mono text-muted">{d.field}</td>
                                <td className="py-1 pr-3 text-subtle">
                                  {d.field.startsWith("colors.") && d.current ? (
                                    <span className="inline-flex items-center gap-1.5">
                                      <span
                                        className="inline-block h-3 w-3 rounded-sm ring-1 ring-inset ring-control"
                                        style={{ backgroundColor: d.current }}
                                      />
                                      {d.current}
                                    </span>
                                  ) : (
                                    (d.current ?? <span className="text-subtle">—</span>)
                                  )}
                                </td>
                                <td className="py-1 font-medium text-ink">
                                  {d.field.startsWith("colors.") && d.proposed ? (
                                    <span className="inline-flex items-center gap-1.5">
                                      <span
                                        className="inline-block h-3 w-3 rounded-sm ring-1 ring-inset ring-control"
                                        style={{ backgroundColor: d.proposed }}
                                      />
                                      {d.proposed}
                                    </span>
                                  ) : (
                                    (d.proposed ?? <span className="text-subtle">—</span>)
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="mt-1 text-[0.6875rem] text-subtle">
                          Approving applies name, colors, and fonts to the kit and downloads the
                          logo; the dashboard theme refreshes on the next render.
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {syncs.length === 0 && (
                <tr>
                  <td colSpan={canEdit ? 7 : 6} className="px-3 py-8 text-center text-subtle">
                    No brand syncs yet — fetch a brand profile to diff it against a kit.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
