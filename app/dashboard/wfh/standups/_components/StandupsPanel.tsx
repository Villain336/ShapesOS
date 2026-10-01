// Marketr — Wave 2 WFH mode slice 4: standups panel (client).
// Compose form + team feed with comment/reaction threads + nudge banner.

"use client";

import { useEffect, useState } from "react";
import { Loader2, Send, ThumbsUp } from "lucide-react";

interface StandupComment {
  id: string;
  userId: string;
  body: string;
  createdAt: string;
}

interface StandupEntry {
  id: string;
  userId: string;
  date: string;
  yesterday: string;
  today: string;
  blockers: string | null;
  videoUrl: string | null;
  visibility: string;
  comments: StandupComment[];
  reactions: { userId: string; emoji: string }[];
}

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";
const labelCls = "block text-[12px] font-medium text-stone-600";
const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight";

const QUICK_REACTIONS = ["🎉", "👍", "🚀", "🙏"];

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export default function StandupsPanel({
  initialStandups,
  me,
}: {
  initialStandups: StandupEntry[];
  me: string;
}) {
  const [standups, setStandups] = useState(initialStandups);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nudge, setNudge] = useState<string | null>(null);

  const [yesterday, setYesterday] = useState("");
  const [today, setToday] = useState("");
  const [blockers, setBlockers] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [visibility, setVisibility] = useState("team");

  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/wfh/standups/nudge")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.copy) setNudge(d.copy);
      })
      .catch(() => {});
  }, []);

  async function reload() {
    const res = await fetch("/api/wfh/standups");
    if (res.ok) {
      const data = await res.json();
      setStandups(data.standups);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wfh/standups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: new Date().toISOString(),
          yesterday,
          today,
          blockers: blockers || null,
          videoUrl: videoUrl || null,
          visibility,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details?.length ? data.details.join(" ") : (data.error ?? "Submit failed"));
      }
      setYesterday("");
      setToday("");
      setBlockers("");
      setVideoUrl("");
      setNudge(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  async function addComment(standupId: string) {
    const body = (commentDrafts[standupId] ?? "").trim();
    if (!body) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/wfh/standups/${standupId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Comment failed");
      setCommentDrafts((d) => ({ ...d, [standupId]: "" }));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Comment failed");
    } finally {
      setBusy(false);
    }
  }

  async function react(standupId: string, emoji: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wfh/standups/${standupId}/reactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Reaction failed");
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reaction failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {nudge && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-800">
          {nudge}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {/* Compose */}
      <div className="rounded-lg border border-stone-200 bg-white px-4 py-4">
        <h2 className="text-[15px] font-semibold text-stone-900">Today&apos;s standup</h2>
        <div className="mt-3 space-y-3">
          <div>
            <label className={labelCls}>Yesterday</label>
            <textarea className={`${inputCls} mt-1 w-full`} rows={2} value={yesterday} onChange={(e) => setYesterday(e.target.value)} placeholder="What did you finish?" />
          </div>
          <div>
            <label className={labelCls}>Today</label>
            <textarea className={`${inputCls} mt-1 w-full`} rows={2} value={today} onChange={(e) => setToday(e.target.value)} placeholder="What are you working on?" />
          </div>
          <div>
            <label className={labelCls}>Blockers <span className="font-normal text-stone-400">(optional)</span></label>
            <textarea className={`${inputCls} mt-1 w-full`} rows={2} value={blockers} onChange={(e) => setBlockers(e.target.value)} placeholder="Anything in your way?" />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className={labelCls}>Video URL <span className="font-normal text-stone-400">(optional)</span></label>
              <input className={`${inputCls} mt-1 w-full`} value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://…" />
            </div>
            <div>
              <label className={labelCls}>Visibility</label>
              <select className={`${inputCls} mt-1 w-full`} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                <option value="team">Team — visible to everyone</option>
                <option value="private">Private — only me</option>
              </select>
            </div>
          </div>
        </div>
        <button type="button" onClick={submit} disabled={busy || !yesterday.trim() || !today.trim()} className={`${btnPrimary} mt-3`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Post standup
        </button>
      </div>

      {/* Feed */}
      <div className="rounded-lg border border-stone-200 bg-white px-4 py-4">
        <h2 className="text-[15px] font-semibold text-stone-900">
          Team feed <span className="font-normal text-stone-500">({standups.length})</span>
        </h2>
        {standups.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-stone-500">
            No standups yet. Post the first one above.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {standups.map((s) => (
              <div key={s.id} className="rounded-md border border-stone-200 px-3 py-3">
                <div className="flex items-center justify-between">
                  <p className="text-[13px] font-medium text-stone-900">
                    {fmtDate(s.date)}
                    {s.userId === me && <span className="ml-2 text-[11px] font-normal text-stone-400">you</span>}
                  </p>
                  <span className={`${chip} ${s.visibility === "team" ? "border-[var(--brand-600)]/20 bg-[var(--brand-50)] text-[var(--brand-700)]" : "border-stone-200 bg-stone-100 text-stone-500"}`}>
                    {s.visibility}
                  </span>
                </div>
                <dl className="mt-2 space-y-1.5 text-[13px]">
                  <div><dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Yesterday</dt><dd className="text-stone-700">{s.yesterday}</dd></div>
                  <div><dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Today</dt><dd className="text-stone-700">{s.today}</dd></div>
                  {s.blockers && <div><dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Blockers</dt><dd className="text-stone-700">{s.blockers}</dd></div>}
                  {s.videoUrl && (
                    <div><dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Video</dt><dd><a href={s.videoUrl} target="_blank" rel="noreferrer" className="text-[var(--brand-600)] hover:underline">Watch update</a></dd></div>
                  )}
                </dl>

                {/* Reactions */}
                <div className="mt-2 flex items-center gap-1.5">
                  {QUICK_REACTIONS.map((e) => {
                    const count = s.reactions.filter((r) => r.emoji === e).length;
                    return (
                      <button
                        key={e}
                        type="button"
                        onClick={() => react(s.id, e)}
                        className="flex items-center gap-1 rounded-full border border-stone-200 px-2 py-0.5 text-[13px] hover:bg-stone-50"
                        title={`React ${e}`}
                      >
                        {e}{count > 0 && <span className="text-[11px] text-stone-500">{count}</span>}
                      </button>
                    );
                  })}
                  <ThumbsUp className="h-3.5 w-3.5 text-stone-300" />
                </div>

                {/* Comments */}
                {s.comments.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-stone-100 pt-2">
                    {s.comments.map((c) => (
                      <p key={c.id} className="text-[13px] text-stone-600">
                        <span className="font-medium text-stone-800">{c.userId === me ? "You" : "Teammate"}: </span>
                        {c.body}
                      </p>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex gap-2">
                  <input
                    className={`${inputCls} flex-1`}
                    value={commentDrafts[s.id] ?? ""}
                    onChange={(e) => setCommentDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
                    placeholder="Add a comment…"
                  />
                  <button type="button" onClick={() => addComment(s.id)} disabled={busy} className={btnGhost}>
                    Reply
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
