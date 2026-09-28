// Marketr — Phase 13C clipper: auto-reframe command builder.
//
// PIPELINE CONTRACT: this module BUILDS ffmpeg commands; it never runs
// them. Execution belongs to W3's job processor (child_process) on the
// container/VPS lane — ffmpeg/cutting/reframe NEVER runs on the edge
// (per the Cloudflare migration plan, spec "Compute reality").
//
// FACE TRACKING HONESTY: real face tracking is NOT implemented here.
// The FaceTracker hook is a pluggable seam: W3 (or a later phase) may
// supply a detector and pass its FaceRegion into buildRenderCommand. When
// no region is supplied, the crop is a plain center crop — safe, honest,
// and the correct default.

import path from "path";
import type { RenderSpec } from "./types";

/** Normalized (0..1) center of the speaker's face in the source frame. */
export interface FaceRegion {
  x: number;
  y: number;
}

/**
 * Pluggable face-detection hook. Receives the source file and the time
 * (seconds) to sample, returns the face center or null when no face is
 * found. BEST-EFFORT: callers must fall back to center crop on null.
 * Default is null — no tracker wired in this phase.
 */
export type FaceTracker = (
  input: string,
  atSec: number,
) => Promise<FaceRegion | null>;

export const DEFAULT_FACE_TRACKER: FaceTracker | null = null;

export interface RenderCommandOptions {
  /** Absolute path to the source media file. */
  input: string;
  /** Absolute path to the ASS caption file to burn in. */
  assPath: string;
  /** Cut window in seconds (source-media timeline). */
  startSec: number;
  endSec: number;
  /** Face center driving the crop x-offset; center crop when omitted. */
  faceRegion?: FaceRegion;
  /** Absolute output path. Defaults to <input>-clip-<start>-<end>.mp4. */
  output?: string;
  /**
   * Source frame dimensions. When known, the crop x-offset is computed
   * numerically (deterministic, testable). When omitted, the filter falls
   * back to ffmpeg stream variables with a centered x.
   */
  sourceW?: number;
  sourceH?: number;
}

const OUT_W = 1080;
const OUT_H = 1920;

/** Clamp n into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Escape a file path for the ffmpeg subtitles filter. */
export function escapeSubtitlePath(p: string): string {
  return `'${p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'")}'`;
}

/**
 * Build the 9:16 reframe filter chain:
 *   crop (9:16, x centered or from faceRegion) → scale=1080:1920 →
 *   subtitles (burned captions).
 *
 * y is always vertically centered (crop height == frame height). The
 * crop keeps the full frame height so TikTok/Reels/Shorts safe areas
 * (top ~150px, bottom ~350px at 1080x1920) remain the caller's concern
 * via caption `position` — captions.ts defaults to "bottom" above the
 * platform UI overlay zone.
 */
export function buildReframeFilter(
  w: number,
  h: number,
  faceRegion?: FaceRegion,
): string {
  const cropW = (h * 9) / 16;
  let xExpr: string;
  if (faceRegion) {
    const x = clamp(faceRegion.x * w - cropW / 2, 0, Math.max(0, w - cropW));
    xExpr = x.toFixed(1);
  } else {
    xExpr = "(iw-ow)/2";
  }
  const crop =
    `crop=w='ih*9/16':h='ih':x='${xExpr}':y='(ih-oh)/2'`;
  return `${crop},scale=${OUT_W}:${OUT_H}`;
}

/** Full video filter chain including burned-in captions. */
export function buildFilterChain(
  w: number | undefined,
  h: number | undefined,
  assPath: string,
  faceRegion?: FaceRegion,
): string {
  const reframe =
    w && h ? buildReframeFilter(w, h, faceRegion) : buildReframeFilterExpr(faceRegion);
  return `${reframe},subtitles=${escapeSubtitlePath(assPath)}`;
}

/** Resolution-agnostic variant used when source dims are unknown. */
function buildReframeFilterExpr(faceRegion?: FaceRegion): string {
  // No numeric face offset possible without w/h — documented center fallback.
  const xExpr = "(iw-ow)/2";
  return `crop=w='ih*9/16':h='ih':x='${xExpr}':y='(ih-oh)/2',scale=${OUT_W}:${OUT_H}`;
}

/** Default output path next to the input: <name>-clip-<start>-<end>.mp4 */
export function defaultOutputPath(input: string, startSec: number, endSec: number): string {
  const parsed = path.parse(input);
  return path.join(
    parsed.dir,
    `${parsed.name}-clip-${Math.round(startSec)}-${Math.round(endSec)}.mp4`,
  );
}

/**
 * Build the full ffmpeg argv for one clip (argv[0] is the ffmpeg binary).
 * Uses input seeking (-ss before -i) + -t duration for frame-accurate,
 * fast cuts. Returned spec is executed by W3's job processor — never here.
 */
export function buildRenderCommand(opts: RenderCommandOptions): RenderSpec {
  const { input, assPath, startSec, endSec } = opts;
  if (!input) throw new Error("buildRenderCommand: input is required");
  if (!assPath) throw new Error("buildRenderCommand: assPath is required");
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    throw new Error("buildRenderCommand: need 0 <= startSec < endSec");
  }
  const duration = +(endSec - startSec).toFixed(3);
  const output = opts.output ?? defaultOutputPath(input, startSec, endSec);
  const filterChain = buildFilterChain(opts.sourceW, opts.sourceH, assPath, opts.faceRegion);

  const ffmpegArgs = [
    "ffmpeg",
    "-hide_banner",
    "-y",
    "-ss",
    String(startSec),
    "-i",
    input,
    "-t",
    String(duration),
    "-vf",
    filterChain,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    output,
  ];

  return {
    input,
    output,
    assPath,
    startSec,
    endSec,
    ...(opts.faceRegion ? { faceRegion: opts.faceRegion } : {}),
    ffmpegArgs,
  };
}
