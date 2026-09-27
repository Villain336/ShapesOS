"use client";

// Marketr — content engine detail (spec §5 flow 3).
// One screen for the full lifecycle: brief → AI draft → editing (live SEO
// score) → published. The score is computed with the same scoreContent()
// the save API persists, so the live number is the stored number.

import { useEffect, useMemo, useState } from "react";
import type { ContentBrief } from "@/lib/content/brief";
import {
  scoreContent,
  type SeoScoreResult,
} from "@/lib/content/seoScore";
import { statusPill } from "./ContentList";

export type ContentDetailItem = {
  id: string;
  status: string;
  bodyMarkdown: string | null;
  seoScore: number | null;
  outlineJson: ContentBrief | null;
  // Phase 12 (embeds): Ghost publish target state (null = never published).
  ghostPostId: string | null;
  ghostStatus: string | null;
  ghostUrl: string | null;
};

const inputCls =
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-accent focus:outline-none";

const btnPrimary =
  "rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";
const btnGhost =
  "rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-800 hover:border-zinc-400 disabled:opacity-50";

export default function ContentDetail({
  projectId,
  item,
}: {
  projectId: string;
  item: ContentDetailItem;
}) {
  const [status, setStatus] = useState(item.status);
  const [body, setBody] = useState(item.bodyMarkdown ?? "");
  const [otherKeywords, setOtherKeywords] = useState<string[]>([]);
  const [llmInfo, setLlmInfo] = useState<{
    name: string;
    isLive: boolean;
    model: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<"draft" | "save" | "publish" | "ghost" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Phase 12 (embeds): Ghost publish state, refreshed from Ghost on mount.
  const [ghost, setGhost] = useState<{
    postId: string | null;
    status: string | null;
    url: string | null;
    stale: boolean;
  }>({
    postId: item.ghostPostId,
    status: item.ghostStatus,
    url: item.ghostUrl,
    stale: false,
  });

  const brief = item.outlineJson;

  // Other saved keywords feed the internal-link check.
  useEffect(() => {
    fetch(`/api/keywords/saved?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const phrases: string[] = (json?.keywords ?? []).map(
          (k: { phrase: string }) => k.phrase,
        );
        setOtherKeywords(phrases);
      })
      .catch(() => {});
  }, [projectId]);

  const scoreInput = useMemo(
    () => ({
      bodyMarkdown: body,
      keyword: brief?.keyword ?? "",
      targetWordCount: brief?.targetWordCount ?? 1500,
      h2s: brief?.h2s ?? [],
      paa: brief?.paa ?? [],
      otherKeywords,
    }),
    [body, brief, otherKeywords],
  );

  // Debounced live score — same function the server persists.
  const [live, setLive] = useState<SeoScoreResult | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setLive(scoreContent(scoreInput)), 400);
    return () => clearTimeout(t);
  }, [scoreInput]);

  const displayed: SeoScoreResult | null =
    live ?? (item.seoScore != null ? { score: item.seoScore, wordCount: 0, checks: [], internalLinkSuggestions: [] } : null);

  async function onGenerateDraft() {
    setBusy("draft");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/content/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: item.id }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Draft generation failed.");
        return;
      }
      setBody(json.draft ?? "");
      setStatus(json.contentItem.status);
      setLlmInfo(json.llm ?? null);
      setNotice("Draft generated — edit freely, the SEO score updates live.");
    } catch {
      setError("Network error. Is the app server running?");
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/content/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: item.id, bodyMarkdown: body }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Save failed.");
        return;
      }
      setStatus(json.contentItem.status);
      setNotice(`Saved. SEO score ${Math.round(json.score.score)}/100.`);
    } catch {
      setError("Network error. Is the app server running?");
    } finally {
      setBusy(null);
    }
  }

  async function onPublish() {
    setBusy("publish");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/content/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: item.id }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Publish failed.");
        return;
      }
      setStatus(json.contentItem.status);
      setNotice("Marked as published. (CMS publishing arrives with the fix-agent phase.)");
    } catch {
      setError("Network error. Is the app server running?");
    } finally {
      setBusy(null);
    }
  }

  // Phase 12 (embeds): refresh the Ghost draft/published status on mount.
  useEffect(() => {
    fetch(`/api/content/ghost?contentId=${encodeURIComponent(item.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const c = json?.contentItem;
        if (c) {
          setGhost({
            postId: c.ghostPostId ?? null,
            status: c.ghostStatus ?? null,
            url: c.ghostUrl ?? null,
            stale: json.stale === true,
          });
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  async function onPublishToGhost(publish: boolean) {
    setBusy("ghost");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/content/ghost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: item.id, publish }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Ghost publish failed.");
        return;
      }
      const c = json.contentItem;
      setGhost({ postId: c.ghostPostId, status: c.ghostStatus, url: c.ghostUrl, stale: false });
      setNotice(
        publish
          ? "Published to Ghost."
          : "Sent to Ghost as a draft. Review it in Ghost before publishing.",
      );
    } catch {
      setError("Network error. Is the app server running?");
    } finally {
      setBusy(null);
    }
  }

  if (!brief) {
    return (
      <p className="text-sm text-red-600">
        This content item has no brief data.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {statusPill(status)}
          <h2 className="text-xl font-bold tracking-tight">{brief.keyword}</h2>
        </div>
        <div className="flex gap-2">
          {status === "brief" && !body && (
            <button onClick={onGenerateDraft} disabled={busy === "draft"} className={btnPrimary}>
              {busy === "draft" ? "Generating…" : "Generate draft"}
            </button>
          )}
          {status !== "published" && body && (
            <button onClick={onPublish} disabled={busy === "publish"} className={btnGhost}>
              {busy === "publish" ? "Publishing…" : "Mark published"}
            </button>
          )}
          {/* Phase 12 (embeds): Ghost Admin API publish — draft by default. */}
          {body && (
            <button
              onClick={() => void onPublishToGhost(false)}
              disabled={busy === "ghost"}
              className={btnGhost}
              title="Send to your Ghost blog as a draft (needs GHOST_URL + GHOST_ADMIN_API_KEY)"
            >
              {busy === "ghost" ? "Sending…" : "Publish to Ghost"}
            </button>
          )}
        </div>
      </div>

      {/* Phase 12 (embeds): Ghost publish status. */}
      {ghost.postId && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50/60 px-4 py-2.5 text-sm">
          <span className="font-medium text-zinc-700">Ghost</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              ghost.status === "published"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-amber-100 text-amber-700"
            }`}
          >
            {ghost.status === "published" ? "Published" : "Draft"}
          </span>
          {ghost.stale && (
            <span className="text-xs text-zinc-500">(last known — Ghost unreachable)</span>
          )}
          {ghost.url && (
            <a
              href={ghost.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-violet-700 hover:text-violet-800"
            >
              Open in Ghost ↗
            </a>
          )}
        </div>
      )}

      {/* SERP provider banner */}
      <div
        className={`rounded-xl border px-4 py-3 text-sm ${
          brief.mock
            ? "border-amber-200 bg-amber-50/40 text-amber-700"
            : "border-emerald-200 bg-emerald-50/40 text-emerald-700"
        }`}
      >
        {brief.mock ? (
          <>
            Brief built from <strong>mock SERP data</strong> — add{" "}
            <span className="font-mono">DATAFORSEO_LOGIN</span> and{" "}
            <span className="font-mono">DATAFORSEO_PASSWORD</span> to{" "}
            <span className="font-mono">.env</span> for live SERP data.
          </>
        ) : (
          <>Brief built from a live DataForSEO SERP.</>
        )}
      </div>

      {/* LLM provider banner */}
      {llmInfo && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            llmInfo.isLive
              ? "border-emerald-200 bg-emerald-50/40 text-emerald-700"
              : "border-amber-200 bg-amber-50/40 text-amber-700"
          }`}
        >
          {llmInfo.isLive ? (
            <>
              Draft generated by <span className="font-mono">{llmInfo.model ?? llmInfo.name}</span>.
            </>
          ) : (
            <>
              <strong>Mock draft</strong> — no LLM call was made. Set{" "}
              <span className="font-mono">LLM_API_KEY</span> (or{" "}
              <span className="font-mono">OPENAI_API_KEY</span>) and{" "}
              <span className="font-mono">LLM_MODEL</span> in{" "}
              <span className="font-mono">.env</span> for real AI drafts.
            </>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      {/* Brief */}
      <section className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <h3 className="mb-4 text-sm font-medium uppercase tracking-widest text-zinc-500">
          Brief
        </h3>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-widest text-zinc-500">Intent</dt>
            <dd className="mt-1">
              <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-500">
                {brief.intent}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-widest text-zinc-500">Target length</dt>
            <dd className="mt-1 text-sm text-zinc-800">
              ~{brief.targetWordCount.toLocaleString()} words
              <span className="text-zinc-500"> (heuristic from SERP depth)</span>
            </dd>
          </div>
        </dl>

        <div className="mt-4">
          <dt className="text-xs uppercase tracking-widest text-zinc-500">Outline</dt>
          <dd className="mt-2 rounded-lg bg-zinc-50/60 p-4">
            <p className="text-base font-bold text-zinc-900"># {brief.h1}</p>
            <ul className="mt-2 flex flex-col gap-1">
              {brief.h2s.map((h) => (
                <li key={h} className="text-sm text-zinc-500">
                  ## {h}
                </li>
              ))}
              {brief.h2s.length === 0 && (
                <li className="text-sm text-zinc-500">No H2s extracted.</li>
              )}
            </ul>
          </dd>
        </div>

        {brief.paa.length > 0 && (
          <div className="mt-4">
            <dt className="text-xs uppercase tracking-widest text-zinc-500">
              Answer these reader questions
            </dt>
            <dd className="mt-2 flex flex-col gap-1.5">
              {brief.paa.map((q) => (
                <p key={q} className="text-sm text-zinc-500">
                  <span className="text-zinc-500">?</span> {q}
                </p>
              ))}
            </dd>
          </div>
        )}

        {brief.entities.length > 0 && (
          <div className="mt-4">
            <dt className="text-xs uppercase tracking-widest text-zinc-500">
              Entities / topics to cover
            </dt>
            <dd className="mt-2 flex flex-wrap gap-1.5">
              {brief.entities.map((e) => (
                <span
                  key={e}
                  className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-500"
                >
                  {e}
                </span>
              ))}
            </dd>
          </div>
        )}

        {brief.sources.length > 0 && (
          <div className="mt-4">
            <dt className="text-xs uppercase tracking-widest text-zinc-500">
              Sources (top {brief.sources.length} SERP results)
            </dt>
            <dd className="mt-2 flex flex-col gap-1">
              {brief.sources.map((s) => (
                <p key={s.url} className="truncate text-xs text-zinc-500">
                  <span className="text-zinc-500">{s.domain}</span> — {s.title}
                </p>
              ))}
            </dd>
          </div>
        )}
      </section>

      {/* Editor + live score */}
      <section className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium uppercase tracking-widest text-zinc-500">
              Editor
            </h3>
            <button onClick={onSave} disabled={busy === "save"} className={btnPrimary}>
              {busy === "save" ? "Saving…" : "Save draft"}
            </button>
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              status === "brief"
                ? "Generate a draft above, or write your own here."
                : "Write your article in markdown…"
            }
            rows={28}
            className={`w-full font-mono text-sm leading-relaxed ${inputCls}`}
          />
          <p className="text-xs text-zinc-500">
            {(displayed?.wordCount ?? 0).toLocaleString()} words · target ~
            {brief.targetWordCount.toLocaleString()}
          </p>
        </div>

        <aside className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white/60 p-5">
          <h3 className="text-sm font-medium uppercase tracking-widest text-zinc-500">
            SEO score
          </h3>
          <p className="text-4xl font-bold tracking-tight text-zinc-900">
            {displayed ? Math.round(displayed.score) : "—"}
            <span className="text-lg text-zinc-500">/100</span>
          </p>
          <ul className="flex flex-col gap-2">
            {displayed?.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-sm">
                <span
                  className={`mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                    c.passed
                      ? "bg-emerald-400"
                      : c.points > 0
                        ? "bg-amber-400"
                        : "bg-zinc-200"
                  }`}
                />
                <span>
                  <span className="text-zinc-500">{c.label}</span>
                  <span className="text-zinc-500">
                    {" "}
                    · {c.points}/{c.max}
                  </span>
                  <br />
                  <span className="text-xs text-zinc-500">{c.detail}</span>
                </span>
              </li>
            )) ?? (
              <li className="text-sm text-zinc-500">Write to see the live score.</li>
            )}
          </ul>
          {displayed && displayed.internalLinkSuggestions.length > 0 && (
            <div className="rounded-lg bg-zinc-50/60 p-3">
              <p className="text-xs uppercase tracking-widest text-zinc-500">
                Link these keywords
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {displayed.internalLinkSuggestions.join(", ")}
              </p>
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}
