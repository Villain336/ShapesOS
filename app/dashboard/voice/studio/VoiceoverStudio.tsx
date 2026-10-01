// Marketr — Phase 13D Worker B: Voiceover Studio.
// Script textarea + VoiceStudio voice picker + pronunciation snapshot preview
// + job table (dense) with audio playback and attach-to-clip.
//
// House pattern (Creative Studio diff, class-by-class): page shell handled
// by the voice layout (bg-canvas p-4 md:p-6); title
// text-xl font-bold tracking-tight text-ink; subtitle
// text-[13px] text-muted; primary buttons
// bg-ink hover:bg-night-hover; DENSE TABLE, rows
// hover:bg-hover-paper; info notes border-line bg-paper.
// Lucide icons only. RareUI/BeautifulUI/shadcn components only.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Mic,
  Play,
  Loader2,
  Trash2,
  Link2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  X,
} from "lucide-react";

const inputCls =
  "rounded-md border border-line bg-paper px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 py-1.5 text-[13px] text-muted hover:bg-hover-paper disabled:opacity-40";

interface Voice {
  voice_id: string;
  name: string;
  type: string;
  description?: string | null;
}

interface PronEntry {
  id: string;
  term: string;
  phonetic: string;
  source: string;
}

interface Job {
  id: string;
  script: string;
  voiceId: string;
  pronunciation: { term: string; phonetic: string }[];
  audioRef: string | null;
  clipId: string | null;
  status: string;
  progress: number;
  error: string | null;
  durationSec: number | null;
  createdAt: string;
}

interface Clip {
  id: string;
  hookText: string | null;
  startSec: number;
  endSec: number;
  viralityScore: number;
  status: string;
  renderStatus: string;
}

// Job statuses are workflow states, not agent states — always a neutral chip.
function statusChip(status: string) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control">
      {status}
    </span>
  );
}

function fmtDuration(sec: number | null): string {
  if (sec === null || sec === undefined) return "—";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function VoiceoverStudio() {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesDown, setVoicesDown] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [script, setScript] = useState("");
  const [pron, setPron] = useState<PronEntry[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [attachFor, setAttachFor] = useState<string | null>(null);
  const [attachClip, setAttachClip] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [vRes, pRes, jRes, cRes] = await Promise.all([
        fetch("/api/voice/voices"),
        fetch("/api/voice/pronunciation"),
        fetch("/api/voice/voiceovers"),
        fetch("/api/voice/clips"),
      ]);
      if (vRes.ok) {
        const v = await vRes.json();
        setVoices(v.voices ?? []);
        if ((v.voices ?? []).length > 0) {
          setVoiceId((cur) => cur || v.voices[0].voice_id);
        }
      } else {
        const b = await vRes.json().catch(() => ({}));
        setVoicesDown(b.error ?? "VoiceStudio unreachable");
      }
      if (pRes.ok) setPron((await pRes.json()).entries ?? []);
      if (jRes.ok) setJobs((await jRes.json()).jobs ?? []);
      if (cRes.ok) setClips((await cRes.json()).clips ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load studio data.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const render = useCallback(async () => {
    if (!script.trim()) {
      setError("Write a script first — empty scripts are rejected.");
      return;
    }
    if (!voiceId) {
      setError("Pick a VoiceStudio voice first.");
      return;
    }
    setRendering(true);
    setError(null);
    try {
      const res = await fetch("/api/voice/voiceovers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script, voiceId, render: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Render failed.");
      setJobs((prev) => [body.job, ...prev]);
      setScript("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Render failed.");
    } finally {
      setRendering(false);
    }
  }, [script, voiceId]);

  const attach = useCallback(async (jobId: string) => {
    if (!attachClip) return;
    try {
      const res = await fetch(`/api/voice/voiceovers/${jobId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "attach", clipId: attachClip }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Attach failed.");
      setJobs((prev) => prev.map((j) => (j.id === jobId ? body.job : j)));
      setAttachFor(null);
      setAttachClip("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Attach failed.");
    }
  }, [attachClip]);

  const remove = useCallback(async (jobId: string) => {
    if (!confirm("Delete this voiceover job and its audio?")) return;
    await fetch(`/api/voice/voiceovers/${jobId}`, { method: "DELETE" });
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="aos-heading">Voiceover Studio</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          TTS narration via the local VoiceStudio backend — paste a script, pick a voice, render, attach to a clip.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* ── Compose ── */}
        <div className="rounded-lg border border-line bg-paper p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-ink">Script</h2>
            <span className="text-[11px] text-subtle">{script.length} / 20,000 chars</span>
          </div>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={8}
            placeholder="Paste the narration script for your clip…"
            className={`${inputCls} w-full resize-y leading-relaxed`}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              className={inputCls}
              aria-label="VoiceStudio voice"
            >
              <option value="">Select a voice…</option>
              {voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name} ({v.voice_id})
                </option>
              ))}
            </select>
            <button className={btnPrimary} onClick={render} disabled={rendering || !script.trim()}>
              {rendering ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
              {rendering ? "Rendering…" : "Render voiceover"}
            </button>
            <button className={btnGhost} onClick={load} disabled={rendering}>
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
          {voicesDown && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-line bg-needs-tint px-3 py-2 text-[12px] text-ink">
              <span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0" role="img" aria-label="Warning" />
              <span>
                VoiceStudio backend is not reachable: {voicesDown}. Start it (~/workspace/voicestudio)
                before rendering — jobs will fail honestly until then.
              </span>
            </div>
          )}
        </div>

        {/* ── Pronunciation snapshot ── */}
        <div className="rounded-lg border border-line bg-paper p-4">
          <h2 className="mb-1 text-[13px] font-semibold text-ink">Pronunciation snapshot</h2>
          <p className="mb-3 text-[12px] text-muted">
            Applied to every render, longest-term-first. Manage the dictionary on the Pronunciation tab.
          </p>
          {pron.length === 0 ? (
            <p className="text-[12px] text-subtle">No entries yet — terms render as written.</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {pron.slice(0, 40).map((e) => (
                <li
                  key={e.id}
                  className="flex items-baseline justify-between gap-2 rounded border border-line px-2 py-1 text-[12px]"
                >
                  <span className="font-medium text-ink">{e.term}</span>
                  <span className="text-muted">→ {e.phonetic}</span>
                </li>
              ))}
            </ul>
          )}
          {pron.length > 40 && (
            <p className="mt-1 text-[11px] text-subtle">+{pron.length - 40} more in the dictionary…</p>
          )}
        </div>
      </div>

      {/* ── Jobs table ── */}
      <div className="overflow-hidden rounded-lg border border-line bg-paper">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-ink">Voiceover jobs</h2>
        </div>
        {jobs.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-subtle">
            No voiceovers yet — render your first one above.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line bg-paper text-left text-[11px] text-muted">
                <th className="px-3 py-2 font-medium">Script</th>
                <th className="px-3 py-2 font-medium">Voice</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Progress</th>
                <th className="px-3 py-2 font-medium">Duration</th>
                <th className="px-3 py-2 font-medium">Pronunciation</th>
                <th className="px-3 py-2 font-medium">Clip</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="max-w-[240px] truncate px-3 py-2 text-ink" title={j.script}>
                    {j.script.slice(0, 60)}
                    {j.script.length > 60 ? "…" : ""}
                  </td>
                  <td className="px-3 py-2 text-muted">{j.voiceId}</td>
                  <td className="px-3 py-2">
                    {statusChip(j.status)}
                    {j.status === "failed" && j.error && (
                      <p className="mt-1 max-w-[220px] text-[11px] text-failed-text" title={j.error}>
                        {j.error.slice(0, 90)}
                        {j.error.length > 90 ? "…" : ""}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-paper">
                        <div
                          className="h-full rounded-full bg-ink"
                          style={{ width: `${Math.round(j.progress * 100)}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-muted">{Math.round(j.progress * 100)}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted">{fmtDuration(j.durationSec)}</td>
                  <td className="px-3 py-2 text-muted">
                    {j.pronunciation?.length > 0 ? (
                      <span className="inline-flex items-center gap-1 text-[12px]">
                        <CheckCircle2 size={13} className="text-ink" />
                        {j.pronunciation.length} applied
                      </span>
                    ) : (
                      <span className="text-[12px] text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {j.clipId ? (
                      <span className="inline-flex items-center gap-1 text-[12px]">
                        <Link2 size={13} className="text-ink" />
                        {j.clipId.slice(0, 8)}…
                      </span>
                    ) : (
                      <span className="text-[12px] text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-muted">
                    {new Date(j.createdAt).toLocaleDateString()} {new Date(j.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {j.status === "ready" && (
                        <button
                          className={btnGhost}
                          title={playingId === j.id ? "Hide player" : "Play audio"}
                          onClick={() => setPlayingId(playingId === j.id ? null : j.id)}
                        >
                          {playingId === j.id ? <X size={14} /> : <Play size={14} />}
                        </button>
                      )}
                      <button
                        className={btnGhost}
                        title="Attach to a 13C clip"
                        onClick={() => {
                          setAttachFor(attachFor === j.id ? null : j.id);
                          setAttachClip(j.clipId ?? "");
                        }}
                      >
                        <Link2 size={14} />
                      </button>
                      <button className={btnGhost} title="Delete job" onClick={() => remove(j.id)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {playingId === j.id && j.status === "ready" && (
                      <div className="mt-1 flex justify-end">
                        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                        <audio controls src={`/api/voice/voiceovers/${j.id}?audio=1`} className="h-8 w-52" />
                      </div>
                    )}
                    {attachFor === j.id && (
                      <div className="mt-1 flex items-center justify-end gap-1">
                        <select
                          value={attachClip}
                          onChange={(e) => setAttachClip(e.target.value)}
                          className={`${inputCls} max-w-[180px]`}
                          aria-label="Attach to clip"
                        >
                          <option value="">Pick a clip…</option>
                          {clips.map((c) => (
                            <option key={c.id} value={c.id}>
                              {(c.hookText ?? "Untitled clip").slice(0, 40)} ({Math.round(c.startSec)}s–
                              {Math.round(c.endSec)}s · {c.status})
                            </option>
                          ))}
                        </select>
                        <button className={btnPrimary} onClick={() => attach(j.id)} disabled={!attachClip}>
                          Attach
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-md border border-line bg-paper px-3 py-2 text-[12px] text-muted">
        <Clock size={14} className="mt-0.5 shrink-0" />
        <span>
          Audio is rendered by the local VoiceStudio backend (no per-minute cost, no keys) and stored in
          the workspace file store. Voice profiles stay consistent per brand — the same voice id always
          renders the same voice.
        </span>
      </div>
    </div>
  );
}
