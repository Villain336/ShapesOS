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
  "rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

const btnPrimary =
  "inline-flex h-control-sm items-center justify-center whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center justify-center whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:opacity-40";
const noteCls = "rounded-md bg-paper px-4 py-3 text-sm text-ink shadow-hairline";

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
      <p role="alert" className="flex items-start gap-2 text-sm text-failed-text">
        <span className="aos-shape aos-shape--failed mt-1 shrink-0" aria-hidden="true" />
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
          <h2 className="text-xl font-heading stretch-heading tracking-heading text-ink">{brief.keyword}</h2>
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
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-paper px-4 py-2.5 text-sm shadow-hairline">
          <span className="font-medium text-ink">Ghost</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              ghost.status === "published"
                ? "bg-ink text-paper"
                : "bg-canvas text-ink"
            }`}
          >
            {ghost.status === "published" ? "Published" : "Draft"}
          </span>
          {ghost.stale && (
            <span className="text-xs text-muted">(last known — Ghost unreachable)</span>
          )}
          {ghost.url && (
            <a
              href={ghost.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-semibold text-ink underline hover:text-focus"
            >
              Open in Ghost ↗
            </a>
          )}
        </div>
      )}

      {/* SERP provider banner */}
      <div className={noteCls}>
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
        <div className={noteCls}>
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

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-failed-text">
          <span className="aos-shape aos-shape--failed mt-1 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      {notice && <p className="text-sm text-ink">{notice}</p>}

      {/* Brief */}
      <section className="rounded-lg bg-paper p-5 shadow-hairline">
        <h3 className="mb-4 text-sm font-semibold text-ink">
          Brief
        </h3>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold text-muted">Intent</dt>
            <dd className="mt-1">
              <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-semibold text-ink">
                {brief.intent}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-muted">Target length</dt>
            <dd className="mt-1 text-sm text-ink">
              ~{brief.targetWordCount.toLocaleString()} words
              <span className="text-muted"> (heuristic from SERP depth)</span>
            </dd>
          </div>
        </dl>

        <div className="mt-4">
          <dt className="text-xs font-semibold text-muted">Outline</dt>
          <dd className="mt-2 rounded-md bg-canvas p-4">
            <p className="text-base font-bold text-ink"># {brief.h1}</p>
            <ul className="mt-2 flex flex-col gap-1">
              {brief.h2s.map((h) => (
                <li key={h} className="text-sm text-muted">
                  ## {h}
                </li>
              ))}
              {brief.h2s.length === 0 && (
                <li className="text-sm text-muted">No H2s extracted.</li>
              )}
            </ul>
          </dd>
        </div>

        {brief.paa.length > 0 && (
          <div className="mt-4">
            <dt className="text-xs font-semibold text-muted">
              Answer these reader questions
            </dt>
            <dd className="mt-2 flex flex-col gap-1.5">
              {brief.paa.map((q) => (
                <p key={q} className="text-sm text-muted">
                  <span className="text-muted">?</span> {q}
                </p>
              ))}
            </dd>
          </div>
        )}

        {brief.entities.length > 0 && (
          <div className="mt-4">
            <dt className="text-xs font-semibold text-muted">
              Entities / topics to cover
            </dt>
            <dd className="mt-2 flex flex-wrap gap-1.5">
              {brief.entities.map((e) => (
                <span
                  key={e}
                  className="rounded-full bg-canvas px-2 py-0.5 text-xs font-semibold text-ink"
                >
                  {e}
                </span>
              ))}
            </dd>
          </div>
        )}

        {brief.sources.length > 0 && (
          <div className="mt-4">
            <dt className="text-xs font-semibold text-muted">
              Sources (top {brief.sources.length} SERP results)
            </dt>
            <dd className="mt-2 flex flex-col gap-1">
              {brief.sources.map((s) => (
                <p key={s.url} className="truncate text-xs text-muted">
                  <span className="text-muted">{s.domain}</span> — {s.title}
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
            <h3 className="text-sm font-semibold text-ink">
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
          <p className="text-xs text-muted">
            {(displayed?.wordCount ?? 0).toLocaleString()} words · target ~
            {brief.targetWordCount.toLocaleString()}
          </p>
        </div>

        <aside className="flex flex-col gap-3 rounded-lg bg-paper p-5 shadow-hairline">
          <h3 className="text-sm font-semibold text-ink">
            SEO score
          </h3>
          <p className="text-3xl font-extrabold stretch-display tracking-display text-ink">
            {displayed ? Math.round(displayed.score) : "—"}
            <span className="text-lg text-muted">/100</span>
          </p>
          <ul className="flex flex-col gap-2">
            {displayed?.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-sm">
                <span
                  className={`mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                    // A content check is not an agent state: monochrome by weight.
                    c.passed
                      ? "bg-ink"
                      : c.points > 0
                        ? "bg-muted"
                        : "bg-line-strong"
                  }`}
                />
                <span>
                  <span className="text-muted">{c.label}</span>
                  <span className="text-muted">
                    {" "}
                    · {c.points}/{c.max}
                  </span>
                  <br />
                  <span className="text-xs text-muted">{c.detail}</span>
                </span>
              </li>
            )) ?? (
              <li className="text-sm text-muted">Write to see the live score.</li>
            )}
          </ul>
          {displayed && displayed.internalLinkSuggestions.length > 0 && (
            <div className="rounded-md bg-canvas p-3">
              <p className="text-xs font-semibold text-muted">
                Link these keywords
              </p>
              <p className="mt-1 text-xs text-muted">
                {displayed.internalLinkSuggestions.join(", ")}
              </p>
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}
