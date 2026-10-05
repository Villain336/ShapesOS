// Marketr — Dataset Builder slice 4 UI: activate tab.
// Phase 4b: pick which compiled version is live per target (rollback /
// roll-forward, confirmed), and BriefNow is a live MCP pull.
// One-click publish of compiled datasets into the BriefNow connector
// (real business-data adapter) and the OS RAG/Feed layer, plus a grounded
// "ask your data" test panel where every answer cites its sources.
// Agentic OS: tokens only, Lucide icons only, sentence case, black pill
// primary actions, pills for pressables.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  FileText,
  Loader2,
  MessageCircleQuestion,
  Plug,
  Rocket,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { confirmAction, toast } from "@/lib/ui/feedback";

interface PublishTargetState {
  target: "briefnow" | "rag";
  label: string;
  published: boolean;
  version: number | null;
  publishedAt: string | null;
  chunkCount: number | null;
  artifactRef: string | null;
  stale: boolean;
  latestVersion: number | null;
}

interface DatasetEntry {
  id: string | null;
  type: string;
  label: string;
  latestVersion: number | null;
  latestChunkCount: number | null;
}

interface Citation {
  chunkId: string;
  documentId: string;
  documentName: string;
  sourceId: string;
  sourceName: string;
  excerpt: string;
  engine: string;
  engineVersion: string;
  datasetVersion: number;
}

interface Answer {
  grounded: boolean;
  answer: string;
  citations: Citation[];
  confidence: "high" | "medium" | "low";
  datasetLabel: string;
  datasetVersion: number;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ActivateView() {
  const [datasets, setDatasets] = useState<DatasetEntry[]>([]);
  const [status, setStatus] = useState<
    Record<string, PublishTargetState[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Selected version per dataset:target (default: latest compile).
  const [chosen, setChosen] = useState<Record<string, number>>({});

  const [askDatasetId, setAskDatasetId] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const dsRes = await fetch("/api/datasets");
    if (!dsRes.ok) {
      setLoading(false);
      return;
    }
    const json = await dsRes.json();
    const list: DatasetEntry[] = (json.datasets ?? []).filter(
      (d: DatasetEntry) => d.id,
    );
    setDatasets(list);
    const entries = await Promise.all(
      list.map(async (d) => {
        const res = await fetch(`/api/datasets/${d.id}/publish-status`);
        if (!res.ok) return [d.id as string, []] as const;
        const s = await res.json();
        return [d.id as string, (s.targets ?? []) as PublishTargetState[]] as const;
      }),
    );
    setStatus(Object.fromEntries(entries));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function publish(
    datasetId: string,
    target: "briefnow" | "rag",
    version: number,
    latest: number,
    label: string,
  ) {
    if (version < latest) {
      const ok = await confirmAction({
        title: `Roll ${label} back to v${version}?`,
        description: `v${version} becomes the live version on this target. v${latest} stays compiled, and you can switch back at any time.`,
        confirmLabel: `Make v${version} live`,
      });
      if (!ok) return;
    }
    setPublishing(`${datasetId}:${target}`);
    setError(null);
    try {
      const res = await fetch(`/api/datasets/${datasetId}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: [target], version }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error ?? `Publish failed (${res.status})`);
      }
      const p = json?.published?.[0];
      if (p) {
        toast({
          title: p.alreadyLive ? `v${p.version} is already live` : `v${p.version} is live on ${p.label}`,
          status: "done",
        });
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setPublishing(null);
    }
  }

  async function ask() {
    if (!askDatasetId || !question.trim()) return;
    setAsking(true);
    setAskError(null);
    setAnswer(null);
    try {
      const res = await fetch(`/api/datasets/${askDatasetId}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error ?? `Ask failed (${res.status})`);
      }
      setAnswer(json as Answer);
    } catch (e) {
      setAskError(e instanceof Error ? e.message : "Ask failed");
    } finally {
      setAsking(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading publish status
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="rounded-lg bg-failed-tint p-4 text-[13px] text-failed-text" role="alert">
          {error}
        </div>
      )}

      {/* Publish cards */}
      {datasets.length === 0 && (
        <div className="rounded-lg bg-paper p-6 text-[14px] text-muted shadow-hairline">
          No datasets yet. Classify chunks and compile a version on the Build
          tab first, then publish it here.
        </div>
      )}
      {datasets.map((d) => {
        const targets = status[d.id as string] ?? [];
        return (
          <div
            key={d.id as string}
            className="rounded-lg bg-paper p-4 shadow-hairline md:p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-semibold">{d.label}</h2>
                <p className="mt-0.5 text-[13px] text-muted">
                  {d.latestVersion !== null
                    ? `Latest compiled version v${d.latestVersion} · ${d.latestChunkCount ?? 0} chunks`
                    : "Not compiled yet — compile a version on the Build tab first"}
                </p>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-3">
              {targets.map((t) => {
                const key = `${d.id}:${t.target}`;
                const latest = d.latestVersion ?? 0;
                const pick = chosen[key] ?? latest;
                const isLive = t.published && t.version === pick;
                const versionOptions = Array.from({ length: latest }, (_, i) => latest - i);
                return (
                <div
                  key={t.target}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3"
                >
                  <Rocket size={16} className="text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold">{t.label}</p>
                    {t.published ? (
                      <p className="mt-0.5 text-[13px] text-muted">
                        v{t.version} live · published {formatDate(t.publishedAt)} ·{" "}
                        {t.chunkCount} chunks
                        <span className="font-mono text-[12px] text-subtle">
                          {" "}
                          {t.artifactRef}
                        </span>
                      </p>
                    ) : (
                      <p className="mt-0.5 text-[13px] text-subtle">
                        Not published yet
                      </p>
                    )}
                    {t.stale && (
                      <p className="mt-1 flex items-center gap-1.5 text-[13px] text-muted">
                        <TriangleAlert size={13} />
                        v{t.latestVersion} compiled — publish it to refresh
                      </p>
                    )}
                    {t.target === "briefnow" && t.published && t.artifactRef?.startsWith("mcp://") && (
                      <p className="mt-1 flex items-start gap-1.5 text-[13px] text-muted">
                        <Plug size={13} className="mt-0.5 shrink-0" />
                        <span>
                          Live pull: your BriefNow connector calls the ShapesOS MCP tool{" "}
                          <span className="font-mono text-[12px]">get_dataset_adapter</span> with{" "}
                          <span className="font-mono text-[12px]">type={d.type}</span>, using a workspace MCP key
                          (Settings → Developers).
                        </span>
                      </p>
                    )}
                  </div>
                  {latest > 1 && (
                    <select
                      value={pick}
                      onChange={(e) => setChosen((c) => ({ ...c, [key]: Number(e.target.value) }))}
                      className="h-10 rounded-full border border-control bg-paper px-3 text-[14px]"
                      aria-label={`Version to make live on ${t.label}`}
                    >
                      {versionOptions.map((v) => (
                        <option key={v} value={v}>
                          v{v}
                          {v === latest ? " (latest)" : ""}
                          {t.published && v === t.version ? " · live" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    disabled={d.latestVersion === null || isLive || publishing === key}
                    onClick={() => void publish(d.id as string, t.target, pick, latest, d.label)}
                    className="aos-press flex h-10 items-center gap-2 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-fg"
                  >
                    {publishing === key ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : pick < latest ? (
                      <RotateCcw size={14} />
                    ) : (
                      <ArrowUpRight size={14} />
                    )}
                    {isLive
                      ? `v${pick} is live`
                      : pick < latest
                        ? `Roll back to v${pick}`
                        : t.published
                          ? `Publish v${pick}`
                          : `Publish to ${t.label}`}
                  </button>
                </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Ask your data */}
      <div className="rounded-lg bg-paper p-4 shadow-hairline md:p-6">
        <div className="flex items-center gap-2">
          <MessageCircleQuestion size={16} className="text-muted" />
          <h2 className="text-[15px] font-semibold">Ask your data</h2>
        </div>
        <p className="mt-1 text-[13px] text-muted">
          Test the live RAG snapshot. Every answer cites the source, document,
          and chunk it came from — or says it could not find an answer.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              value={askDatasetId}
              onChange={(e) => setAskDatasetId(e.target.value)}
              className="h-11 rounded-full border border-control bg-paper px-4 text-[14px]"
              aria-label="Dataset to ask"
            >
              <option value="">Choose a dataset</option>
              {datasets.map((d) => (
                <option key={d.id as string} value={d.id as string}>
                  {d.label}
                </option>
              ))}
            </select>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void ask();
              }}
              placeholder="Ask a question about your business data"
              className="h-11 min-w-0 flex-1 rounded-full border border-control bg-paper px-4 text-[14px] placeholder:text-subtle"
              aria-label="Question"
            />
            <button
              type="button"
              disabled={!askDatasetId || !question.trim() || asking}
              onClick={() => void ask()}
              className="aos-press flex h-11 items-center justify-center gap-2 rounded-full bg-black px-6 text-[15px] font-semibold text-white disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-fg"
            >
              {asking ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <MessageCircleQuestion size={15} />
              )}
              Ask
            </button>
          </div>
          {askError && (
            <p className="text-[13px] text-failed-text" role="alert">
              {askError}
            </p>
          )}
          {answer && (
            <div className="mt-2 rounded-lg border border-line p-4">
              <p className="text-[14px]">{answer.answer}</p>
              <p className="mt-2 text-[12px] text-subtle">
                {answer.grounded
                  ? `${answer.datasetLabel} · v${answer.datasetVersion} · confidence ${answer.confidence}`
                  : "No grounded answer — add documents covering this topic"}
              </p>
              {answer.citations.length > 0 && (
                <div className="mt-3 flex flex-col gap-2">
                  {answer.citations.map((c) => (
                    <div
                      key={c.chunkId}
                      className="rounded-lg bg-canvas p-3"
                    >
                      <p className="flex items-center gap-1.5 font-mono text-[12px] text-muted">
                        <FileText size={12} />
                        {c.sourceName} → {c.documentName} → chunk{" "}
                        <span className="text-subtle">{c.chunkId.slice(0, 12)}</span>
                      </p>
                      <p className="mt-1 text-[13px] text-muted">
                        “{c.excerpt}”
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-subtle">
                        {c.engine} {c.engineVersion}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
