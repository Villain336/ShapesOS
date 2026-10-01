// Marketr — Clips home (Phase 13C "Clipper").
// Source library → scored clip drafts → brand-styled captions → Postiz drafts.
// Tabs: [Sources] [Clips] [Jobs]. Clips are drafts until approved; queueing
// sends a DRAFT to Postiz — nothing publishes automatically.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clapperboard,
  Library,
  Link2,
  ListVideo,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Scissors,
  Send,
  UploadCloud,
  X,
} from "lucide-react";
import {
  api,
  fmtTime,
  progressPct,
  type BrandKit,
  type CaptionStyle,
  type Clip,
  type ClipJob,
  type ClipSource,
} from "./api";

// ── Small atoms (AOS local) ───

// Clip/job/source statuses are provider states, not agent states — neutral chips.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control">
      {children}
    </span>
  );
}

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const inputCls =
  "rounded-md border-[1.5px] border-control bg-paper px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[13px] font-medium text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-full bg-paper px-2.5 py-1.5 text-[13px] font-medium text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";

// Spec switch (44x26 pill track, white 20px knob) with a visible label.
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-muted">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors ${
          checked ? "bg-ink" : "bg-disabled-fg"
        }`}
      >
        <span
          className={`absolute top-[3px] h-5 w-5 rounded-full bg-white transition-all ${
            checked ? "left-[21px]" : "left-[3px]"
          }`}
        />
      </button>
      {label}
    </label>
  );
}

const EMPTY_STYLE: CaptionStyle = {
  font: "Inter",
  size: 44,
  position: "bottom",
  textColor: "#ffffff",
  highlightColor: "#7c3aed",
  highlight: true,
};

function jobLabel(kind: string): string {
  if (kind === "transcribe") return "Transcribe";
  if (kind === "generate") return "Generate clips";
  if (kind === "render") return "Render";
  return kind;
}

// ── New-source dialog (upload file | from URL) ───────────────────────────────

function NewSourceDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"upload" | "url">("upload");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "upload") {
        if (!file) throw new Error("Choose a video file to upload.");
        const form = new FormData();
        form.append("file", file);
        if (title.trim()) form.append("title", title.trim());
        await api("/api/clipper/sources", { method: "POST", body: form });
      } else {
        if (!url.trim()) throw new Error("Paste a video URL.");
        await api("/api/clipper/sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: url.trim(), title: title.trim() || undefined }),
        });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4">
      <div className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-paper shadow-overlay">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">New source</h2>
          <button onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">
          {error && (
            <div role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text">
              <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          <div className="mb-4 flex gap-1 border-b border-line">
            {(
              [
                { id: "upload", label: "Upload file", icon: UploadCloud },
                { id: "url", label: "From URL", icon: Link2 },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
                  mode === id
                    ? "border-ink text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>

          <label className="mb-1 block text-[12px] font-medium text-muted">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={mode === "upload" ? "Auto-filled from the file name" : "e.g. Q3 product webinar"}
            className={`${inputCls} mb-4 w-full`}
            maxLength={160}
          />

          {mode === "upload" ? (
            <label className="block cursor-pointer rounded-lg border-2 border-dashed border-line px-4 py-6 text-center transition hover:border-ink/50">
              <UploadCloud size={20} className="mx-auto text-subtle" />
              <div className="mt-1.5 text-[13px] font-medium text-ink">
                {file ? file.name : "Choose a video file"}
              </div>
              <div className="mt-0.5 text-[11px] text-muted">MP4, MOV, WebM — long-form works best</div>
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ""));
                  e.target.value = "";
                }}
              />
            </label>
          ) : (
            <>
              <label className="mb-1 block text-[12px] font-medium text-muted">Video URL</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                className={`${inputCls} w-full`}
                inputMode="url"
              />
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button onClick={onClose} className={btnGhost} disabled={busy}>Cancel</button>
          <button onClick={create} className={btnPrimary} disabled={busy}>
            {busy ? <Loader2 size={14} className="aos-spin" /> : <Plus size={14} />}
            Add source
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Generate-clips dialog ────────────────────────────────────────────────────

function GenerateDialog({
  source,
  onClose,
  onJob,
}: {
  source: ClipSource;
  onClose: () => void;
  onJob: (job: ClipJob) => void;
}) {
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ job: ClipJob }>(`/api/clipper/sources/${source.id}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count }),
      });
      onJob({ ...r.job, sourceId: source.id });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generate failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4">
      <div className="w-full max-w-sm overflow-hidden rounded-lg bg-paper shadow-overlay">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">Generate clips</h2>
          <button onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">
          {error && (
            <div role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text">
              <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
          <p className="mb-3 text-[13px] text-muted">
            Scores candidate segments from <span className="font-medium text-ink">{source.title}</span> and
            drafts the top {count}. Runs as one background job.
          </p>
          <label className="mb-1 block text-[12px] font-medium text-muted">Number of clips</label>
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
            className={`${inputCls} w-24`}
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button onClick={onClose} className={btnGhost} disabled={busy}>Cancel</button>
          <button onClick={run} className={btnPrimary} disabled={busy}>
            {busy ? <Loader2 size={14} className="aos-spin" /> : <Scissors size={14} />}
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sources tab ────────────────────────────────────────────────────────────

function SourcesTab({ onJob, goJobs }: { onJob: (job: ClipJob) => void; goJobs: () => void }) {
  const [sources, setSources] = useState<ClipSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [genFor, setGenFor] = useState<ClipSource | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ sources: ClipSource[] }>("/api/clipper/sources");
      setSources(r.sources);
    } catch {
      // keep previous list on transient failure
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => void load()} className={btnGhost}>
          <RefreshCw size={14} /> Refresh
        </button>
        <div className="ml-auto">
          <button onClick={() => setDialogOpen(true)} className={btnPrimary}>
            <Plus size={14} /> New source
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-paper">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11px] tracking-wide text-muted">
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Origin</th>
              <th className="px-3 py-2 font-medium">Duration</th>
              <th className="px-3 py-2 font-medium">Transcript</th>
              <th className="px-3 py-2 font-medium">Clips</th>
              <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                <td className="px-3 py-2 font-medium text-ink">{s.title}</td>
                <td className="px-3 py-2">
                  <Chip>
                    {s.origin === "url" ? "URL" : "Upload"}
                  </Chip>
                </td>
                <td className="px-3 py-2 text-muted">{fmtTime(s.durationSec)}</td>
                <td className="px-3 py-2">
                  <Chip>
                    {s.transcriptStatus === "processing" && <Loader2 size={10} className="aos-spin" />}
                    {s.transcriptStatus}
                  </Chip>
                </td>
                <td className="px-3 py-2 text-muted">{s._count?.clips ?? 0}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => setGenFor(s)}
                    className={btnGhost}
                    disabled={s.transcriptStatus !== "ready"}
                    title={s.transcriptStatus !== "ready" ? "Transcript must be ready before generating clips" : "Generate clips"}
                  >
                    <Scissors size={14} /> Generate clips
                  </button>
                </td>
              </tr>
            ))}
            {sources.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[13px] text-subtle">
                  No sources yet — add the first one with “New source”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {dialogOpen && (
        <NewSourceDialog onClose={() => setDialogOpen(false)} onDone={() => { setDialogOpen(false); load(); }} />
      )}
      {genFor && (
        <GenerateDialog
          source={genFor}
          onClose={() => setGenFor(null)}
          onJob={(j) => {
            onJob(j);
            goJobs();
          }}
        />
      )}
    </div>
  );
}

// ── Caption style editor (drawer section) ────────────────────────────────────

interface BrandPreset {
  id: string;
  name: string;
  font: string;
  textColor: string;
  highlightColor: string;
}

function CaptionEditor({
  style,
  onChange,
  previewText,
}: {
  style: CaptionStyle;
  onChange: (s: CaptionStyle) => void;
  previewText: string;
}) {
  const [kits, setKits] = useState<BrandKit[]>([]);

  useEffect(() => {
    api<{ brandKits: BrandKit[] }>("/api/brand-kits")
      .then((r) => setKits(r.brandKits))
      .catch(() => {});
  }, []);

  // Brand-style presets from workspace kits; default-kit fallback first.
  const presets: BrandPreset[] = useMemo(() => {
    const fromKits = kits.map((k) => ({
      id: k.id,
      name: k.name,
      font: k.fonts.heading || k.fonts.body || "Inter",
      textColor: k.colors.text || "#ffffff",
      highlightColor: k.colors.primary || "#7c3aed",
    }));
    return [
      { id: "default", name: "Default (Inter, white, brand)", font: "Inter", textColor: "#ffffff", highlightColor: "#7c3aed" },
      ...fromKits,
    ];
  }, [kits]);

  const fontOptions = useMemo(() => {
    const fonts = new Set<string>(["Inter", style.font ?? "", ...presets.map((p) => p.font)]);
    return [...fonts].filter(Boolean);
  }, [presets, style.font]);

  const set = (patch: Partial<CaptionStyle>) => onChange({ ...style, ...patch });

  const positionCls =
    style.position === "top" ? "items-start pt-8" : style.position === "middle" ? "items-center" : "items-end pb-8";

  const words = previewText.split(/\s+/).filter(Boolean);
  const hlCount = style.highlight ? Math.min(3, words.length) : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-muted">Brand preset</label>
          <select
            className={`${inputCls} w-full`}
            value={presets.find((p) => p.font === style.font && p.highlightColor === style.highlightColor && p.textColor === style.textColor)?.id ?? ""}
            onChange={(e) => {
              const p = presets.find((x) => x.id === e.target.value);
              if (p) set({ font: p.font, textColor: p.textColor, highlightColor: p.highlightColor });
            }}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            <option value="">Custom…</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-muted">Font</label>
          <select className={`${inputCls} w-full`} value={style.font} onChange={(e) => set({ font: e.target.value })}>
            {fontOptions.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-muted">Size ({style.size ?? 44}px)</label>
          <input
            type="range"
            min={24}
            max={72}
            value={style.size ?? 44}
            onChange={(e) => set({ size: Number(e.target.value) })}
            className="w-full accent-ink"
          />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-muted">Position</label>
          <select
            className={`${inputCls} w-full`}
            value={style.position ?? "bottom"}
            onChange={(e) => set({ position: e.target.value as CaptionStyle["position"] })}
          >
            <option value="top">Top</option>
            <option value="middle">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-muted">Text color</label>
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={style.textColor ?? "#ffffff"}
              onChange={(e) => set({ textColor: e.target.value })}
              className="h-8 w-10 cursor-pointer rounded border border-line bg-paper p-0.5"
            />
            <input
              value={style.textColor ?? "#ffffff"}
              onChange={(e) => set({ textColor: e.target.value })}
              className={`${inputCls} w-full font-mono text-[12px]`}
              maxLength={7}
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-muted">Highlight color</label>
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={style.highlightColor ?? "#7c3aed"}
              onChange={(e) => set({ highlightColor: e.target.value })}
              className="h-8 w-10 cursor-pointer rounded border border-line bg-paper p-0.5"
            />
            <input
              value={style.highlightColor ?? "#7c3aed"}
              onChange={(e) => set({ highlightColor: e.target.value })}
              className={`${inputCls} w-full font-mono text-[12px]`}
              maxLength={7}
            />
          </div>
        </div>
      </div>

      <div className="flex cursor-pointer items-center gap-2">
        <Switch checked={!!style.highlight} onChange={(v) => set({ highlight: v })} label="Word highlight on the hook" />
      </div>

      <div>
        <div className="mb-1 text-[12px] font-medium text-muted">Preview (9:16)</div>
        <div className={`flex aspect-[9/16] h-56 justify-center rounded-lg bg-stone-900 ${positionCls} px-6`}>
          <p
            className="text-center font-bold leading-snug"
            style={{
              fontFamily: style.font ?? "Inter",
              fontSize: `${(style.size ?? 44) / 3.2}px`,
              color: style.textColor ?? "#ffffff",
            }}
          >
            {words.map((w, i) =>
              i < hlCount ? (
                <span key={i} style={{ backgroundColor: style.highlightColor ?? "#7c3aed" }} className="rounded px-1">
                  {w}{" "}
                </span>
              ) : (
                <span key={i}>{w} </span>
              ),
            )}
            {words.length === 0 && <span className="text-subtle">Caption preview</span>}
          </p>
        </div>
      </div>
    </div>
  );
}

interface PostizChannel {
  id: string;
  identifier: string;
  name: string | null;
  picture: string | null;
  connectedAt: string | null;
}

// ── Clip detail drawer ───────────────────────────────────────────────────────

function ClipDrawer({
  clip,
  onClose,
  onChange,
  onJob,
}: {
  clip: Clip;
  onClose: () => void;
  onChange: () => void;
  onJob: (job: ClipJob) => void;
}) {
  const [c, setC] = useState(clip);
  const [style, setStyle] = useState<CaptionStyle>(clip.captionStyle ?? EMPTY_STYLE);
  const [captionText, setCaptionText] = useState(
    (clip.captions?.segments ?? []).map((s) => s.text).join("\n"),
  );
  const [channels, setChannels] = useState<PostizChannel[]>([]);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setC(clip);
    setStyle(clip.captionStyle ?? EMPTY_STYLE);
    setCaptionText((clip.captions?.segments ?? []).map((s) => s.text).join("\n"));
    setChannelIds([]);
    setError(null);
  }, [clip]);

  useEffect(() => {
    api<{ channels: PostizChannel[] }>("/api/integrations/postiz/channels")
      .then((r) => setChannels(r.channels))
      .catch(() => {});
  }, []);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  const patchClip = async (body: Record<string, unknown>) => {
    const r = await api<{ clip: Clip }>(`/api/clipper/clips/${c.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setC(r.clip);
  };

  const saveStyle = () =>
    run("style", () => patchClip({ captionStyle: style }));

  const saveCaptions = () =>
    run("captions", () => {
      const lines = captionText.split("\n").map((l) => l.trim()).filter(Boolean);
      const prev = c.captions?.segments ?? [];
      const span = (c.endSec - c.startSec) / Math.max(1, lines.length);
      const segments = lines.map((text, i) => ({
        text,
        start: prev[i]?.start ?? c.startSec + i * span,
        end: prev[i]?.end ?? c.startSec + (i + 1) * span,
      }));
      return patchClip({ captions: { segments } }).then(() => undefined);
    });

  const render = () =>
    run("render", async () => {
      const r = await api<{ job?: ClipJob; clip?: Clip }>(`/api/clipper/clips/${c.id}/render`, { method: "POST" });
      if (r.job) onJob({ ...r.job, sourceId: c.sourceId });
      if (r.clip) setC(r.clip);
    });

  const toPostiz = () =>
    run("postiz", async () => {
      if (channelIds.length === 0) throw new Error("Select at least one Postiz channel first.");
      const r = await api<{ clip: Clip }>(`/api/clipper/clips/${c.id}/to-postiz`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelIds }),
      });
      setC(r.clip);
    });

  const hook = c.hookText?.trim() || (c.captions?.segments ?? [])[0]?.text || "—";
  const canApprove = c.status === "draft";
  // API: only draft|approved clips render (409 otherwise), and never while processing.
  const canRender =
    (c.status === "draft" || c.status === "approved") && c.renderStatus !== "processing" && c.renderStatus !== "ready";

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-paper shadow-overlay">
        <div className="flex items-start justify-between border-b border-line px-4 py-3.5">
          <div>
            <h3 className="text-[15px] font-semibold text-ink">
              Clip {fmtTime(c.startSec)} – {fmtTime(c.endSec)}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Chip>{Math.round(c.viralityScore)} / 100</Chip>
              <Chip>{c.status}</Chip>
              <Chip>render: {c.renderStatus}</Chip>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text">
              <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <section>
            <div className="mb-1.5 text-[12px] font-medium tracking-wide text-muted">Hook</div>
            <p className="text-[13.5px] font-medium leading-snug text-ink">“{hook}”</p>
          </section>

          <section>
            <div className="mb-1.5 text-[12px] font-medium tracking-wide text-muted">Why it scored</div>
            {(c.scoreReasons ?? []).length > 0 ? (
              <ul className="space-y-1.5">
                {(c.scoreReasons ?? []).map((r, i) => (
                  <li key={i} className="rounded-md border border-line bg-canvas px-2.5 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-medium text-ink">{r.label}</span>
                      {r.weight != null && (
                        <span className="font-mono text-[11px] text-muted">+{r.weight}</span>
                      )}
                    </div>
                    {r.detail && <div className="mt-0.5 text-[12px] text-muted">{r.detail}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">No score reasons recorded.</p>
            )}
          </section>

          <section>
            <div className="mb-2 text-[12px] font-medium tracking-wide text-muted">Caption style</div>
            <CaptionEditor style={style} onChange={setStyle} previewText={hook === "—" ? "" : hook} />
            <button onClick={saveStyle} className={`${btnGhost} mt-2.5`} disabled={!!busy}>
              {busy === "style" ? <Loader2 size={14} className="aos-spin" /> : <CheckCircle2 size={14} />}
              Save caption style
            </button>
          </section>

          <section>
            <div className="mb-1.5 text-[12px] font-medium tracking-wide text-muted">
              Captions ({(c.captions?.segments ?? []).length} segments)
            </div>
            <textarea
              value={captionText}
              onChange={(e) => setCaptionText(e.target.value)}
              rows={4}
              placeholder="No captions yet — render will generate them."
              className={`${inputCls} w-full`}
            />
            <button onClick={saveCaptions} className={`${btnGhost} mt-2`} disabled={!!busy}>
              {busy === "captions" ? <Loader2 size={14} className="aos-spin" /> : <Pencil size={14} />}
              Save captions
            </button>
          </section>

          <section className="border-t border-line pt-4">
            <div className="mb-2 text-[12px] font-medium tracking-wide text-muted">Actions</div>
            <div className="flex flex-wrap gap-2">
              {canApprove && (
                <button onClick={() => run("approve", () => patchClip({ action: "approve" }))} className={btnPrimary} disabled={!!busy}>
                  {busy === "approve" ? <Loader2 size={14} className="aos-spin" /> : <CheckCircle2 size={14} />}
                  Approve
                </button>
              )}
              {canRender && (
                <button onClick={render} className={btnGhost} disabled={!!busy} title="Render the 9:16 video with captions">
                  {busy === "render" ? <Loader2 size={14} className="aos-spin" /> : <Clapperboard size={14} />}
                  Render
                </button>
              )}
            </div>
            {c.status === "approved" && !c.postizRef && (
              <div className="mt-3 space-y-2">
                {c.renderStatus !== "ready" ? (
                  <p className="text-[12.5px] text-muted">
                    Render the clip first — queueing needs a rendered file.
                  </p>
                ) : (
                  <>
                    <div className="text-[12px] font-medium text-muted">Postiz channels</div>
                    {channels.length === 0 ? (
                      <p className="text-[12px] text-muted">
                        No channels connected yet. Connect them in Social → Channels, then come back.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {channels.map((ch) => {
                          const on = channelIds.includes(ch.id);
                          return (
                            <button
                              key={ch.id}
                              type="button"
                              aria-pressed={on}
                              onClick={() =>
                                setChannelIds((prev) =>
                                  on ? prev.filter((id) => id !== ch.id) : [...prev, ch.id],
                                )
                              }
                              className={`rounded-full px-2.5 py-1 text-[12px] font-medium aos-press transition ${
                                on
                                  ? "bg-ink text-white"
                                  : "bg-paper text-muted shadow-outline hover:text-ink"
                              }`}
                            >
                              {ch.name ?? ch.identifier}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div>
                      <button onClick={toPostiz} className={btnGhost} disabled={!!busy || channelIds.length === 0}>
                        {busy === "postiz" ? <Loader2 size={14} className="aos-spin" /> : <Send size={14} />}
                        Queue to Postiz (draft)
                      </button>
                      <p className="mt-1.5 text-[12px] leading-snug text-muted">
                        Creates a <strong className="text-ink">draft</strong> in Postiz for your
                        approval — nothing publishes automatically.
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
            {c.postizRef && (
              <p className="mt-2 text-[12px] text-muted">
                Postiz draft: <span className="font-mono text-ink">{c.postizRef}</span>
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Clips tab ──────────────────────────────────────────────────────────────

function ClipsTab({ onJob }: { onJob: (job: ClipJob) => void }) {
  const [sources, setSources] = useState<ClipSource[]>([]);
  const [sourcesReady, setSourcesReady] = useState(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [fSource, setFSource] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const r = await api<{ sources: ClipSource[] }>("/api/clipper/sources");
      setSources(r.sources);
    } catch {
      // keep previous list on transient failure
    } finally {
      setSourcesReady(true);
    }
  }, []);

  // NOTE: the API requires sourceId on GET /api/clipper/clips (400 without
  // it), so "All sources" fans out per source and merges by score order.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const srcIds = fSource ? [fSource] : sources.map((s) => s.id);
      const results = await Promise.all(
        srcIds.map((id) =>
          api<{ clips: Clip[] }>(`/api/clipper/clips?sourceId=${encodeURIComponent(id)}`),
        ),
      );
      setClips(results.flatMap((r) => r.clips));
    } catch {
      // keep previous list on transient failure
    } finally {
      setLoading(false);
    }
  }, [fSource, sources]);

  useEffect(() => {
    loadSources();
  }, [loadSources]);
  useEffect(() => {
    if (sourcesReady) load();
  }, [load, sourcesReady]);

  const filtered = useMemo(
    () => (fStatus ? clips.filter((c) => c.status === fStatus) : clips),
    [clips, fStatus],
  );

  const selected = useMemo(() => clips.find((c) => c.id === selectedId) ?? null, [clips, selectedId]);

  const quickAction = async (clip: Clip, fn: () => Promise<unknown>) => {
    setBusyId(clip.id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  };

  const approve = (clip: Clip) =>
    quickAction(clip, () =>
      api(`/api/clipper/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
    );

  const render = (clip: Clip) =>
    quickAction(clip, async () => {
      const r = await api<{ job?: ClipJob }>(`/api/clipper/clips/${clip.id}/render`, { method: "POST" });
      if (r.job) onJob({ ...r.job, sourceId: clip.sourceId });
    });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={fSource} onChange={(e) => setFSource(e.target.value)} className={inputCls}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={inputCls}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="approved">Approved</option>
          <option value="queued">Queued</option>
          <option value="posted">Posted</option>
          <option value="failed">Failed</option>
        </select>
        <button onClick={() => void load()} className={btnGhost}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text">
          <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line bg-paper">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11px] tracking-wide text-muted">
              <th className="px-3 py-2 font-medium">Score</th>
              <th className="px-3 py-2 font-medium">Time range</th>
              <th className="px-3 py-2 font-medium">Duration</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Render</th>
              <th className="px-3 py-2 font-medium text-right"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`cursor-pointer border-b border-line last:border-0 hover:bg-hover-paper ${selectedId === c.id ? "bg-canvas" : ""}`}
              >
                <td className="px-3 py-2">
                  <Chip>{Math.round(c.viralityScore)}</Chip>
                </td>
                <td className="px-3 py-2 font-medium text-ink">
                  {fmtTime(c.startSec)} – {fmtTime(c.endSec)}
                </td>
                <td className="px-3 py-2 text-muted">{fmtTime(c.endSec - c.startSec)}</td>
                <td className="px-3 py-2"><Chip>{c.status}</Chip></td>
                <td className="px-3 py-2">
                  <Chip>
                    {c.renderStatus === "processing" && <Loader2 size={10} className="aos-spin" />}
                    {c.renderStatus}
                  </Chip>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => setSelectedId(c.id)}
                      className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink"
                      title="Edit captions"
                      aria-label="Edit captions"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => void approve(c)}
                      className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink disabled:opacity-40"
                      title={c.status === "draft" ? "Approve" : "Already approved"}
                      aria-label="Approve"
                      disabled={busyId === c.id || c.status !== "draft"}
                    >
                      <CheckCircle2 size={14} />
                    </button>
                    <button
                      onClick={() => void render(c)}
                      className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink disabled:opacity-40"
                      title={(c.status === "draft" || c.status === "approved") && c.renderStatus !== "processing" ? "Render" : "Render (draft/approved clips only)"}
                      aria-label="Render"
                      disabled={busyId === c.id || !((c.status === "draft" || c.status === "approved") && c.renderStatus !== "processing")}
                    >
                      <Clapperboard size={14} />
                    </button>
                    <button
                      onClick={() => setSelectedId(c.id)}
                      className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink"
                      title="Queue to Postiz (draft) — pick channels in the drawer"
                      aria-label="Queue to Postiz"
                    >
                      <Send size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[13px] text-subtle">
                  {clips.length === 0
                    ? "No clips yet — generate some from a source."
                    : "No clips match your filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <ClipDrawer
          clip={selected}
          onClose={() => setSelectedId(null)}
          onChange={load}
          onJob={onJob}
        />
      )}
    </div>
  );
}

// ── Jobs tab ─────────────────────────────────────────────────────────────────

function JobsTab({ jobs, setJobs }: { jobs: ClipJob[]; setJobs: React.Dispatch<React.SetStateAction<ClipJob[]>> }) {
  const [loading, setLoading] = useState(false);

  // Persisted job list (GET /api/clipper/jobs) merged with in-session jobs.
  const tryList = useCallback(async () => {
    try {
      const r = await api<{ jobs: ClipJob[] }>("/api/clipper/jobs");
      setJobs((prev) => {
        const byId = new Map(prev.map((j) => [j.id, j]));
        for (const j of r.jobs) byId.set(j.id, j);
        return [...byId.values()].sort(
          (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
        );
      });
    } catch {
      // list endpoint not present yet — session jobs only
    }
  }, [setJobs]);

  const poll = useCallback(
    async (ids: string[]) => {
      await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await api<{ job: ClipJob }>(`/api/clipper/jobs/${id}`);
            setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...r.job } : j)));
          } catch {
            // transient — keep last known state
          }
        }),
      );
    },
    [setJobs],
  );

  const active = useMemo(
    () => jobs.filter((j) => j.status === "pending" || j.status === "processing"),
    [jobs],
  );

  useEffect(() => {
    tryList();
  }, [tryList]);

  useEffect(() => {
    if (active.length === 0) return;
    const t = setInterval(() => {
      setLoading(true);
      poll(active.map((j) => j.id)).finally(() => setLoading(false));
    }, 3000);
    return () => clearInterval(t);
  }, [active.length, poll]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={() => {
            setLoading(true);
            void poll(jobs.map((j) => j.id)).then(() => tryList()).finally(() => setLoading(false));
          }}
          className={btnGhost}
        >
          <RefreshCw size={14} className={loading ? "aos-spin" : ""} /> Refresh
        </button>
        <span className="text-[12px] text-subtle">
          “Clip this 2-hour webinar into 10 shorts” runs as one generate job — watch it here.
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-paper">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11px] tracking-wide text-muted">
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Progress</th>
              <th className="px-3 py-2 font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                <td className="px-3 py-2 font-medium text-ink">{jobLabel(j.kind)}</td>
                <td className="px-3 py-2">
                  <Chip>
                    {(j.status === "pending" || j.status === "processing") && (
                      <Loader2 size={10} className="aos-spin" />
                    )}
                    {j.status}
                  </Chip>
                </td>
                <td className="px-3 py-2">
                  <div className="flex w-40 items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-canvas">
                      <div
                        className={`h-full rounded-full transition-all ${j.status === "failed" ? "bg-failed" : "bg-ink"}`}
                        style={{ width: `${j.status === "done" ? 100 : progressPct(j.progress)}%` }}
                      />
                    </div>
                    <span className="w-9 text-right font-mono text-[11px] text-muted">
                      {j.status === "done" ? 100 : progressPct(j.progress)}%
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-[12.5px] text-failed-text">{j.error ?? "—"}</td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-[13px] text-subtle">
                  No jobs yet — generate clips from a source to start one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Clips app shell ──────────────────────────────────────────────────────────

const TABS = [
  { id: "sources", label: "Sources", icon: Library },
  { id: "clips", label: "Clips", icon: Scissors },
  { id: "jobs", label: "Jobs", icon: ListVideo },
] as const;

export function ClipsApp() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("sources");
  const [jobs, setJobs] = useState<ClipJob[]>([]);

  const trackJob = useCallback((job: ClipJob) => {
    setJobs((prev) => {
      const byId = new Map(prev.map((j) => [j.id, j]));
      byId.set(job.id, { ...byId.get(job.id), ...job });
      return [...byId.values()];
    });
  }, []);

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

      <div className="mb-3 rounded-lg border border-line bg-canvas px-3 py-2.5 text-[12.5px] text-muted">
        <span className="font-medium text-ink">Drafts until you approve. </span>
        Clips are drafts until you approve them. Queueing sends a draft to Postiz — nothing publishes automatically.
      </div>

      {tab === "sources" && <SourcesTab onJob={trackJob} goJobs={() => setTab("jobs")} />}
      {tab === "clips" && <ClipsTab onJob={trackJob} />}
      {tab === "jobs" && <JobsTab jobs={jobs} setJobs={setJobs} />}
    </div>
  );
}
