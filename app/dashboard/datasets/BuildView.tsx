// Marketr — Dataset Builder slice 3 UI: build tab.
// Versioned dataset compiler + dataset health panel (coverage, freshness,
// staleness alerts). Agentic OS: tokens only, Lucide icons only, sentence
// case, black pill primary actions, pills for pressables.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  Database,
  Download,
  History,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

interface DatasetEntry {
  id: string | null;
  type: string;
  label: string;
  appliedChunks: number;
  latestVersion: number | null;
  latestCompiledAt: string | null;
  latestChunkCount: number | null;
}

interface HealthDataset {
  type: string;
  label: string;
  appliedChunks: number;
  coveragePct: number;
  latestVersion: number | null;
  latestCompiledAt: string | null;
  newestDataAt: string | null;
  newestDataAgeDays: number | null;
  stale: boolean;
  chunksSinceCompile: number;
}

interface HealthAlert {
  datasetType: string | null;
  label: string;
  severity: "stale" | "drift" | "uncompiled";
  message: string;
}

interface VersionEntry {
  id: string;
  version: number;
  chunkCount: number;
  compiledAt: string;
  sources: { id: string; name: string; chunkCount: number }[];
  engines: { name: string; version: string; chunkCount: number }[];
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatAge(days: number | null): string {
  if (days === null) return "—";
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

export function BuildView() {
  const [datasets, setDatasets] = useState<DatasetEntry[]>([]);
  const [health, setHealth] = useState<HealthDataset[]>([]);
  const [alerts, setAlerts] = useState<HealthAlert[]>([]);
  const [coverage, setCoverage] = useState({ total: 0, classified: 0, pct: 0 });
  const [loading, setLoading] = useState(true);
  const [compiling, setCompiling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState<Record<string, boolean>>({});
  const [versions, setVersions] = useState<Record<string, VersionEntry[]>>({});
  const [versionsLoading, setVersionsLoading] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [dsRes, healthRes] = await Promise.all([
      fetch("/api/datasets"),
      fetch("/api/datasets/health"),
    ]);
    if (dsRes.ok) {
      const json = await dsRes.json();
      setDatasets(json.datasets ?? []);
    }
    if (healthRes.ok) {
      const json = await healthRes.json();
      setHealth(json.datasets ?? []);
      setAlerts(json.alerts ?? []);
      setCoverage({
        total: json.totalChunks ?? 0,
        classified: json.classifiedChunks ?? 0,
        pct: json.coveragePct ?? 0,
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function compile(type: string) {
    setCompiling(type);
    setError(null);
    try {
      const res = await fetch("/api/datasets/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error ?? `Compile failed (${res.status})`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Compile failed");
    } finally {
      setCompiling(null);
    }
  }

  async function toggleVersions(datasetId: string) {
    const open = versionsOpen[datasetId] ?? false;
    setVersionsOpen((v) => ({ ...v, [datasetId]: !open }));
    if (!open && !versions[datasetId]) {
      setVersionsLoading(datasetId);
      try {
        const res = await fetch(`/api/datasets/${datasetId}/versions`);
        if (res.ok) {
          const json = await res.json();
          setVersions((v) => ({ ...v, [datasetId]: json.versions ?? [] }));
        }
      } finally {
        setVersionsLoading(null);
      }
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading datasets
      </div>
    );
  }

  const healthByType = new Map(health.map((h) => [h.type, h]));

  return (
    <div className="flex flex-col gap-4">
      {/* Health panel */}
      <div className="rounded-lg bg-paper p-4 shadow-hairline md:p-6">
        <h2 className="text-[15px] font-semibold">Dataset health</h2>
        <div className="mt-3 flex flex-wrap items-center gap-6">
          <div>
            <p className="font-mono text-[24px] font-semibold">{coverage.pct}%</p>
            <p className="text-[13px] text-muted">coverage</p>
            <p className="text-[12px] text-subtle">
              {formatCount(coverage.classified)} of {formatCount(coverage.total)} chunks
              classified into datasets
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold">Freshness</p>
            <div className="mt-1 flex flex-col gap-1">
              {health.map((h) => (
                <div
                  key={h.type}
                  className="flex items-center justify-between gap-3 text-[13px]"
                >
                  <span className="text-muted">{h.label}</span>
                  <span className="font-mono text-[12px] text-subtle">
                    newest data {formatAge(h.newestDataAgeDays)}
                    {h.latestVersion !== null && ` · v${h.latestVersion}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        {alerts.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {alerts.map((a, i) => (
              <div
                key={`${a.severity}-${a.datasetType ?? "all"}-${i}`}
                role="alert"
                className="flex items-start gap-2 rounded-md bg-needs px-3 py-2 text-[13px]"
              >
                <TriangleAlert size={15} className="mt-0.5 shrink-0 text-needs-text" />
                <span>{a.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-[14px] text-failed-text">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {/* Dataset cards */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {datasets.map((d) => {
          const h = healthByType.get(d.type);
          const isOpen = d.id ? (versionsOpen[d.id] ?? false) : false;
          return (
            <div key={d.type} className="rounded-lg bg-paper p-4 shadow-hairline">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 text-[15px] font-semibold">
                    <Database size={15} className="text-muted" />
                    {d.label}
                  </p>
                  <p className="mt-1 text-[13px] text-muted">
                    {formatCount(d.appliedChunks)}{" "}
                    {d.appliedChunks === 1 ? "chunk" : "chunks"} classified
                    {h && ` · ${h.coveragePct}% of all chunks`}
                  </p>
                  <p className="font-mono text-[12px] text-subtle">
                    {d.latestVersion !== null
                      ? `v${d.latestVersion} · ${formatCount(d.latestChunkCount ?? 0)} chunks · compiled ${formatDate(d.latestCompiledAt)}`
                      : "Not compiled yet"}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={compiling === d.type || d.appliedChunks === 0}
                  onClick={() => void compile(d.type)}
                  className="aos-press flex h-10 items-center gap-2 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:opacity-50"
                >
                  {compiling === d.type ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                  {compiling === d.type ? "Compiling" : "Compile"}
                </button>
                {d.id && d.latestVersion !== null && (
                  <>
                    <a
                      href={`/api/datasets/${d.id}/export?format=jsonl`}
                      className="aos-press flex h-10 items-center gap-2 rounded-full bg-paper px-5 text-[14px] font-semibold shadow-hairline"
                    >
                      <Download size={15} />
                      JSONL
                    </a>
                    <a
                      href={`/api/datasets/${d.id}/export?format=parquet`}
                      className="aos-press flex h-10 items-center gap-2 rounded-full bg-paper px-5 text-[14px] font-semibold shadow-hairline"
                    >
                      <Download size={15} />
                      Parquet
                    </a>
                    <button
                      type="button"
                      onClick={() => void toggleVersions(d.id as string)}
                      className="aos-press flex h-10 items-center gap-2 rounded-full px-4 text-[14px] font-semibold text-muted"
                      aria-expanded={isOpen}
                    >
                      <History size={15} />
                      Versions
                      <ChevronDown
                        size={14}
                        className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                  </>
                )}
              </div>

              {isOpen && d.id && (
                <div className="mt-3 border-t border-line pt-3">
                  {versionsLoading === d.id ? (
                    <div className="flex items-center gap-2 text-sm text-muted">
                      <Loader2 size={14} className="animate-spin" />
                      Loading versions
                    </div>
                  ) : (versions[d.id] ?? []).length === 0 ? (
                    <p className="text-[13px] text-muted">No versions yet</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {(versions[d.id] ?? []).map((v) => (
                        <div key={v.id} className="rounded-md bg-canvas px-3 py-2">
                          <p className="text-[13px] font-semibold">
                            v{v.version} · {formatCount(v.chunkCount)}{" "}
                            {v.chunkCount === 1 ? "chunk" : "chunks"} ·{" "}
                            <span className="font-normal text-muted">
                              {formatDate(v.compiledAt)}
                            </span>
                          </p>
                          <p className="mt-1 font-mono text-[12px] text-subtle">
                            {v.sources.length}{" "}
                            {v.sources.length === 1 ? "source" : "sources"} ·{" "}
                            {v.engines
                              .map((e) => `${e.name} ${e.version}`)
                              .join(", ")}
                          </p>
                          <p className="mt-1 text-[12px] text-subtle">
                            {v.sources
                              .slice(0, 3)
                              .map((s) => s.name)
                              .join(" · ")}
                            {v.sources.length > 3 &&
                              ` +${v.sources.length - 3} more`}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
