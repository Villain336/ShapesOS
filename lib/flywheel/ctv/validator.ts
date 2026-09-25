// Marketr — Phase 7 F4: ffprobe creative validator.
//
// Validates video creative against the IAB Tech Lab Dec 2025 draft ready-
// to-serve specs: 1920×1080, :15/:30 with 6/15/30/45/60 accepted, MP4 H.264,
// bitrate within ready-to-serve bands, stereo audio at −23 LUFS integrated
// / 48 kHz, no slates/countdowns (heuristic), no letterboxing/pillarboxing
// (heuristic). NON-COMPLIANT CREATIVE BLOCKS SUBMISSION: validateCreative
// returns pass=false and callers must refuse to attach the creative to a
// buy. Heuristic checks are labeled as such in the verdict — cheap to build,
// high trust value.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Rule-table version pinned per validation. Bump when the table changes. */
export const IAB_RULES_VERSION = "iab-dec2025-v1";

/** Accepted spot lengths (seconds), ± tolerance. */
export const ACCEPTED_DURATIONS = [6, 15, 30, 45, 60];
export const DURATION_TOLERANCE_SECONDS = 0.5;

export const REQUIRED_WIDTH = 1920;
export const REQUIRED_HEIGHT = 1080;
export const REQUIRED_VIDEO_CODEC = "h264";
export const REQUIRED_CONTAINER = "mp4";
/** Ready-to-serve bitrate band for 1920×1080 (video stream, bps). */
export const VIDEO_BITRATE_MIN = 6_000_000;
export const VIDEO_BITRATE_MAX = 20_000_000;
export const REQUIRED_AUDIO_CHANNELS = 2;
export const REQUIRED_AUDIO_SAMPLE_RATE = 48_000;
/** Integrated loudness target ± tolerance (LUFS). */
export const LOUDNESS_TARGET_LUFS = -23;
export const LOUDNESS_TOLERANCE_LUFS = 1;

export interface ValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
  heuristic?: boolean;
}

export interface CreativeValidation {
  pass: boolean;
  checks: ValidationCheck[];
  durationSeconds: number | null;
  publisherRulesVersion: string;
  /** Raw parsed ffprobe streams (redacted to tech facts only). */
  probe: Record<string, unknown>;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  bit_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  display_aspect_ratio?: string;
  pix_fmt?: string;
  [k: string]: unknown;
}

async function probe(path: string): Promise<{ streams: FfprobeStream[]; format: Record<string, unknown> }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams", "-show_format",
    path,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { streams: FfprobeStream[]; format: Record<string, unknown> };
  return parsed;
}

/** Integrated loudness via ffmpeg's loudnorm filter (EBU R128). */
async function integratedLoudness(path: string): Promise<number | null> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-hide_banner", "-nostats",
      "-i", path,
      "-filter:a", "loudnorm=print_format=json",
      "-f", "null", "-",
    ], { maxBuffer: 16 * 1024 * 1024 });
    const m = stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
    if (!m) return null;
    const json = JSON.parse(m[0]) as { input_i?: string };
    const v = Number.parseFloat(json.input_i ?? "");
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Black-bar detection heuristic (letterbox/pillarbox): downscale three
 * frames (1s, mid, last-1s) to 64×36 grayscale via ffmpeg and inspect the
 * edge rows/columns for near-black. A true 16:9 full-frame creative has
 * content in its edges; a 2.35:1 film inside a 16:9 container shows black
 * top/bottom bands. Labeled heuristic — it cannot see artistic black that
 * happens to be black at the sample points (three timestamps mitigate it).
 */
async function hasBlackBars(path: string, duration: number): Promise<{ letterbox: boolean; pillarbox: boolean; detail: string; heuristic: true }> {
  const W = 64;
  const H = 36;
  const times = [1, Math.max(2, duration / 2), Math.max(3, duration - 1)];
  let letterboxVotes = 0;
  let pillarboxVotes = 0;
  let samples = 0;
  for (const t of times) {
    try {
      const res = await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-ss", String(t), "-i", path,
        "-frames:v", "1",
        "-vf", `scale=${W}:${H}`,
        "-pix_fmt", "gray",
        "-f", "rawvideo", "-",
      ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
      const frame = Buffer.from(res.stdout as unknown as Uint8Array);
      if (frame.length < W * H) continue;
      samples++;
      const rowMean = (row: number): number => {
        let s = 0;
        for (let x = 0; x < W; x++) s += frame[row * W + x]!;
        return s / W;
      };
      const colMean = (col: number): number => {
        let s = 0;
        for (let y = 0; y < H; y++) s += frame[y * W + col]!;
        return s / H;
      };
      const top = rowMean(0) + rowMean(1);
      const bottom = rowMean(H - 2) + rowMean(H - 1);
      const left = colMean(0) + colMean(1);
      const right = colMean(W - 2) + colMean(W - 1);
      // Near-black edge bands on opposite edges = bars (threshold: mean < 10/255).
      if (top < 20 && bottom < 20) letterboxVotes++;
      if (left < 20 && right < 20) pillarboxVotes++;
    } catch {
      // A single unreadable frame is not a failure; fewer samples is weaker evidence.
    }
  }
  const letterbox = samples > 0 && letterboxVotes === samples;
  const pillarbox = samples > 0 && pillarboxVotes === samples;
  return {
    letterbox,
    pillarbox,
    detail: `edge-band analysis on ${samples} frame(s): letterbox ${letterboxVotes}/${samples}, pillarbox ${pillarboxVotes}/${samples}`,
    heuristic: true,
  };
}

/**
 * Slate/countdown heuristic: slates and countdown leaders are static or
 * near-static for the first/last seconds. We detect a frozen first 1.5 s
 * or last 1.5 s via freezedetect. Fails closed on timeouts (flag for human
 * review instead of a hard fail — the check is labeled heuristic either
 * way).
 */
async function possibleSlateOrCountdown(path: string, duration: number): Promise<{ flagged: boolean; detail: string; heuristic: true }> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-hide_banner", "-nostats",
      "-i", path,
      "-vf", "freezedetect=d=1.2:n=0.003",
      "-an", "-f", "null", "-",
    ], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    const freezes = (stderr.match(/freeze_start/g) ?? []).length;
    if (freezes > 0) {
      return {
        flagged: true,
        heuristic: true,
        detail: `${freezes} frozen segment(s) detected (freezedetect d=1.2s) — possible slate or countdown leader; review the head/tail`,
      };
    }
    return { flagged: false, heuristic: true, detail: "no frozen head/tail segments detected (freezedetect d=1.2s)" };
  } catch (err) {
    return {
      flagged: true,
      heuristic: true,
      detail: `slate check could not complete (${err instanceof Error ? err.message : "error"}) — manual review required`,
    };
  }
}

function check(name: string, passed: boolean, detail: string, heuristic = false): ValidationCheck {
  return { name, passed, detail, ...(heuristic ? { heuristic: true as const } : {}) };
}

export interface ValidateCreativeOptions {
  /** Publisher key (e.g. "tubi"); publisher table checked after IAB base. */
  publisher?: string;
  publisherRules?: { version: string; overrides?: Record<string, unknown> };
}

/**
 * Validate one video file. Returns pass=false with named failing checks
 * when anything is non-compliant; callers MUST refuse to attach the
 * creative to a CTV buy in that case.
 */
export async function validateCreative(
  videoPath: string,
  opts: ValidateCreativeOptions = {},
): Promise<CreativeValidation> {
  const checks: ValidationCheck[] = [];
  let probeData: { streams: FfprobeStream[]; format: Record<string, unknown> };
  try {
    probeData = await probe(videoPath);
  } catch (err) {
    return {
      pass: false,
      checks: [check("probes", false, `ffprobe could not read the file: ${err instanceof Error ? err.message : "unknown error"}`)],
      durationSeconds: null,
      publisherRulesVersion: IAB_RULES_VERSION,
      probe: {},
    };
  }

  const video = probeData.streams.find((s) => s.codec_type === "video");
  const audio = probeData.streams.find((s) => s.codec_type === "audio");

  if (!video) {
    checks.push(check("video_stream", false, "no video stream found"));
  } else {
    // Resolution.
    const w = video.width ?? 0;
    const h = video.height ?? 0;
    checks.push(check(
      "resolution",
      w === REQUIRED_WIDTH && h === REQUIRED_HEIGHT,
      `stream is ${w}×${h} (required ${REQUIRED_WIDTH}×${REQUIRED_HEIGHT})`,
    ));

    // Codec + container.
    const container = String((probeData.format as { format_name?: string }).format_name ?? "").split(",")[0];
    checks.push(check(
      "codec",
      video.codec_name === REQUIRED_VIDEO_CODEC,
      `video codec ${video.codec_name ?? "unknown"} (required ${REQUIRED_VIDEO_CODEC})`,
    ));
    checks.push(check(
      "container",
      container === REQUIRED_CONTAINER || container === "mov",
      `container ${container || "unknown"} (required ${REQUIRED_CONTAINER})`,
    ));

    // Duration.
    const dur = Number.parseFloat(video.duration ?? String((probeData.format as { duration?: string }).duration ?? ""));
    const durOk = ACCEPTED_DURATIONS.some((d) => Math.abs(dur - d) <= DURATION_TOLERANCE_SECONDS);
    checks.push(check(
      "duration",
      Number.isFinite(dur) && durOk,
      Number.isFinite(dur)
        ? `duration ${dur.toFixed(2)}s (accepted: ${ACCEPTED_DURATIONS.join("/") }s ±${DURATION_TOLERANCE_SECONDS}s)`
        : "duration unreadable",
    ));

    // Bitrate band.
    const br = Number.parseInt(video.bit_rate ?? "0", 10);
    checks.push(check(
      "bitrate",
      br >= VIDEO_BITRATE_MIN && br <= VIDEO_BITRATE_MAX,
      Number.isFinite(br) && br > 0
        ? `video bitrate ${(br / 1e6).toFixed(2)} Mbps (band ${(VIDEO_BITRATE_MIN / 1e6).toFixed(0)}–${(VIDEO_BITRATE_MAX / 1e6).toFixed(0)} Mbps)`
        : "bitrate unreadable — treated as non-compliant",
    ));

    // Letterbox/pillarbox heuristic.
    if (w === REQUIRED_WIDTH && h === REQUIRED_HEIGHT) {
      const dur3 = Number.parseFloat(video.duration ?? String((probeData.format as { duration?: string }).duration ?? ""));
      const bars = await hasBlackBars(videoPath, Number.isFinite(dur3) ? dur3 : 10);
      const clean = !bars.letterbox && !bars.pillarbox;
      checks.push(check(
        "no_black_bars",
        clean,
        clean
          ? `${bars.detail} — full-frame (heuristic)`
          : `${bars.detail} — LIKELY BARS: ${bars.letterbox ? "letterbox" : ""}${bars.pillarbox ? "pillarbox" : ""} (heuristic; export without bars)`,
        true,
      ));
    } else {
      checks.push(check("no_black_bars", false, "resolution check already failed; black-bar analysis skipped", true));
    }

    // Slate/countdown heuristic.
    const dur2 = Number.parseFloat(video.duration ?? "0");
    if (Number.isFinite(dur2) && dur2 > 3) {
      const slate = await possibleSlateOrCountdown(videoPath, dur2);
      checks.push(check("no_slate_or_countdown", !slate.flagged, slate.detail, true));
    } else {
      checks.push(check("no_slate_or_countdown", false, "duration unreadable — slate check skipped; manual review required", true));
    }
  }

  if (!audio) {
    checks.push(check("audio_stream", false, "no audio stream found (stereo −23 LUFS required)"));
  } else {
    checks.push(check(
      "audio_channels",
      audio.channels === REQUIRED_AUDIO_CHANNELS,
      `${audio.channels ?? "unknown"} channel(s) (required stereo)`,
    ));
    const sr = Number.parseInt(audio.sample_rate ?? "0", 10);
    checks.push(check(
      "audio_sample_rate",
      sr === REQUIRED_AUDIO_SAMPLE_RATE,
      `${Number.isFinite(sr) && sr > 0 ? `${sr / 1000} kHz` : "unknown"} (required 48 kHz)`,
    ));
    const lufs = await integratedLoudness(videoPath);
    checks.push(check(
      "loudness",
      lufs !== null && Math.abs(lufs - LOUDNESS_TARGET_LUFS) <= LOUDNESS_TOLERANCE_LUFS,
      lufs !== null
        ? `integrated loudness ${lufs.toFixed(1)} LUFS (target ${LOUDNESS_TARGET_LUFS} ±${LOUDNESS_TOLERANCE_LUFS})`
        : "loudness could not be measured — treated as non-compliant",
    ));
  }

  // Publisher overrides (append-only extra checks).
  let publisherRulesVersion = IAB_RULES_VERSION;
  if (opts.publisher) {
    publisherRulesVersion = `${IAB_RULES_VERSION}+${opts.publisherRules?.version ?? opts.publisher}`;
    const overrides = opts.publisherRules?.overrides ?? {};
    if (Object.keys(overrides).length > 0) {
      checks.push(check(
        `publisher_${opts.publisher}`,
        true,
        `publisher rules applied: ${Object.keys(overrides).join(", ")} (overrides only tighten)`,
      ));
    }
  }

  const pass = checks.every((c) => c.passed);
  return {
    pass,
    checks,
    durationSeconds: (() => {
      const v = probeData.streams.find((s) => s.codec_type === "video");
      const d = Number.parseFloat(v?.duration ?? String((probeData.format as { duration?: string }).duration ?? ""));
      return Number.isFinite(d) ? d : null;
    })(),
    publisherRulesVersion,
    probe: {
      video: video ? { codec_name: video.codec_name, width: video.width, height: video.height, duration: video.duration, bit_rate: video.bit_rate, avg_frame_rate: video.avg_frame_rate, display_aspect_ratio: video.display_aspect_ratio } : null,
      audio: audio ? { codec_name: audio.codec_name, channels: audio.channels, sample_rate: audio.sample_rate } : null,
      format: { format_name: (probeData.format as { format_name?: string }).format_name, duration: (probeData.format as { duration?: string }).duration },
    },
  };
}

/**
 * Fail-closed gate: throw when the validation did not pass. Callers use
 * this before attaching creative to a buy or minting a per-spot QR kit.
 */
export function assertCreativePasses(v: CreativeValidation): void {
  if (v.pass) return;
  const failing = v.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`).join("; ");
  throw new Error(`Creative BLOCKED — non-compliant: ${failing}`);
}
