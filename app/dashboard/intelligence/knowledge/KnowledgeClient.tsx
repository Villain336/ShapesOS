// Marketr — Wave 2 context.dev slice 2: knowledge client (tabs + tables).
// Sources tab: register form + source table with approve/reject/crawl.
// Crawl jobs tab: job history with pages/chunks/credits.

"use client";

import { useState } from "react";
import { Plus, Globe, Check, X, Play, Loader2 } from "lucide-react";

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

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  pending_approval: "bg-amber-50 text-amber-700 ring-amber-200",
  archived: "bg-stone-100 text-stone-500 ring-stone-200",
};

const JOB_BADGE: Record<string, string> = {
  queued: "bg-stone-100 text-stone-600 ring-stone-200",
  running: "bg-sky-50 text-sky-700 ring-sky-200",
  complete: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  failed: "bg-red-50 text-red-700 ring-red-200",
};

export function KnowledgeClient({
  initialSources,
  initialJobs,
  canEdit,
}: {
  initialSources: Source[];
  initialJobs: Job[];
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<"sources" | "jobs">("sources");
  const [sources, setSources] = useState(initialSources);
  const [jobs, setJobs] = useState(initialJobs);
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState("");
  const [sourceType, setSourceType] = useState("page");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const [s, j] = await Promise.all([
      fetch("/api/knowledge/contextdev/sources").then((r) => r.json()),
      fetch("/api/knowledge/contextdev/jobs").then((r) => r.json()),
    ]);
    if (s.sources) setSources(s.sources);
    if (j.jobs) setJobs(j.jobs);
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

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] text-stone-700">
          {notice}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex gap-1 border-b border-stone-200">
          {(
            [
              ["sources", "Sources"],
              ["jobs", "Crawl jobs"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-3 pb-2 text-[13px] font-medium ${
                tab === key
                  ? "border-[var(--brand-600)] text-[var(--brand-700)]"
                  : "border-transparent text-stone-500 hover:text-stone-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {canEdit && tab === "sources" && (
          <button
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)]"
          >
            <Plus className="h-3.5 w-3.5" /> Add source
          </button>
        )}
      </div>

      {showForm && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-stone-200 bg-white p-3">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-[12px] font-medium text-stone-600">
            URL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/docs or sitemap.xml"
              className="rounded-md border border-stone-200 px-2.5 py-1.5 text-[13px] text-stone-900 outline-none focus:border-[var(--brand-600)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
            Type
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
              className="rounded-md border border-stone-200 px-2.5 py-1.5 text-[13px] text-stone-900 outline-none focus:border-[var(--brand-600)]"
            >
              <option value="page">Single page</option>
              <option value="sitemap">Sitemap (crawl)</option>
              <option value="brand">Brand profile</option>
            </select>
          </label>
          <button
            onClick={addSource}
            disabled={busy === "add" || !url.trim()}
            className="flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
          >
            {busy === "add" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Register
          </button>
        </div>
      )}

      {tab === "sources" ? (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[12px] font-medium text-stone-500">
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
                <tr key={s.id} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5 font-medium text-stone-900">
                      <Globe className="h-3.5 w-3.5 text-stone-400" />
                      <span className="max-w-72 truncate">{s.url}</span>
                    </div>
                    <div className="pl-5 text-[12px] text-stone-500">{s.domain}</div>
                  </td>
                  <td className="px-3 py-2 text-stone-600">{s.sourceType}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[12px] font-medium ring-1 ring-inset ${
                        STATUS_BADGE[s.status] ?? "bg-stone-100 text-stone-600 ring-stone-200"
                      }`}
                    >
                      {s.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-stone-700">{s._count.chunks}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-stone-700">{s._count.jobs}</td>
                  {canEdit && (
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1.5">
                        {s.status === "pending_approval" && (
                          <>
                            <button
                              title="Approve"
                              onClick={() => act(s.id, "approve")}
                              disabled={busy !== null}
                              className="rounded-md border border-stone-200 p-1.5 text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button
                              title="Reject"
                              onClick={() => act(s.id, "reject")}
                              disabled={busy !== null}
                              className="rounded-md border border-stone-200 p-1.5 text-red-600 hover:bg-red-50 disabled:opacity-40"
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
                            className="flex items-center gap-1 rounded-md border border-stone-200 px-2 py-1 text-[12px] font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-40"
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
                  <td colSpan={canEdit ? 6 : 5} className="px-3 py-8 text-center text-stone-500">
                    No sources yet — add your first page, sitemap, or brand profile.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[12px] font-medium text-stone-500">
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Pages</th>
                <th className="px-3 py-2 text-right">Credits</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                  <td className="px-3 py-2">
                    <div className="max-w-80 truncate font-medium text-stone-900">
                      {j.source?.url ?? "—"}
                    </div>
                    <div className="text-[12px] text-stone-500">
                      {new Date(j.createdAt).toLocaleString()}
                      {j.error && <span className="text-red-600"> · {j.error}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[12px] font-medium ring-1 ring-inset ${
                        JOB_BADGE[j.status] ?? "bg-stone-100 text-stone-600 ring-stone-200"
                      }`}
                    >
                      {j.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-stone-700">{j.pagesFetched}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-stone-700">{j.creditsUsed}</td>
                </tr>
              ))}
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-stone-500">
                    No crawl jobs yet.
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
