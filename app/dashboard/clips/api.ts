// Marketr — Clips (Phase 13C clipper) client API helpers.
// Coded against the W3 API contract:
//   GET    /api/clipper/sources               → { sources: [{id,title,origin,durationSec,transcriptStatus,_count?}] }
//   POST   /api/clipper/sources                (multipart file | {url,title})
//   POST   /api/clipper/sources/[id]/generate  {count} → { job }
//   GET    /api/clipper/clips?sourceId=         → { clips: [...] }
//   PATCH  /api/clipper/clips/[id]              {captionStyle?,captions?,action:"approve"} → { clip }
//   POST   /api/clipper/clips/[id]/render       → { job } | { clip }
//   POST   /api/clipper/clips/[id]/to-postiz    → { clip }
//   GET    /api/clipper/jobs                   → { jobs: ClipJob[] } (recent, desc)
//   GET    /api/clipper/jobs/[id]               → { job }
"use client";

export interface ClipSource {
  id: string;
  title: string;
  origin: "upload" | "url" | string;
  durationSec: number | null;
  transcriptStatus: "pending" | "processing" | "ready" | "failed";
  _count?: { clips: number };
}

export interface ScoreReason {
  label: string;
  detail?: string;
  weight?: number;
}

export interface CaptionStyle {
  font?: string;
  size?: number; // px at 1080p
  position?: "top" | "middle" | "bottom";
  textColor?: string;
  highlightColor?: string;
  highlight?: boolean;
}

export interface CaptionSegment {
  text: string;
  start: number;
  end: number;
}

export interface Clip {
  id: string;
  sourceId: string;
  startSec: number;
  endSec: number;
  viralityScore: number;
  scoreReasons: ScoreReason[];
  hookText?: string | null;
  captionStyle: CaptionStyle;
  captions?: { segments: CaptionSegment[] } | null;
  status: "draft" | "approved" | "queued" | "posted" | "failed";
  renderStatus: "pending" | "processing" | "ready" | "failed";
  outputRef?: string | null;
  postizRef?: string | null;
}

export interface ClipJob {
  id: string;
  kind: string; // transcribe | generate | render
  sourceId?: string | null;
  status: "pending" | "processing" | "done" | "failed";
  progress: number; // 0–100
  error?: string | null;
  createdAt?: string;
}

export interface BrandKit {
  id: string;
  name: string;
  isDefault: boolean;
  colors: Record<string, string>; // { primary, secondary, accent, text, muted }
  fonts: Record<string, string>; // { heading, body }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || Number.isNaN(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

/** Normalise job progress to a 0–100 percentage (API ships a Float, treat ≤1 as a fraction). */
export function progressPct(p: number): number {
  const pct = p <= 1 ? p * 100 : p;
  return Math.round(Math.min(100, Math.max(0, pct)));
}
